// server.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcrypt');
const User = require('./models/User'); 

// Load environment variables (MUST be the first thing!)
dotenv.config();

// === 1. INITIALIZE APP & PORT ===
const app = express(); 
const PORT = process.env.PORT || 3000; 

// Trust the proxy (essential for cookies in Render)
app.set('trust proxy', 1);

// === 2. DATABASE CONNECTION ===
mongoose.connect(process.env.DATABASE_URL)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('DB Connection Error:', err));

// === 3. MIDDLEWARE & VIEW ENGINE SETUP ===
app.set('view engine', 'ejs'); 
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Express Session Middleware
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        sameSite: 'Lax' // Critical fix for cross-origin redirects/cookies
    } 
}));

// Global locals for EJS templates
app.use((req, res, next) => {
    res.locals.isLoggedIn = !!req.session.userId;
    res.locals.error = req.session.error; 
    res.locals.message = req.session.message; 
    delete req.session.error; 
    delete req.session.message;
    next();
});

// === 4. AUTH MIDDLEWARE === 
function isLoggedIn(req, res, next) {
    if (req.session.userId) {
        return next();
    }
    req.session.error = 'You must be logged in to access that page.';
    res.redirect('/login');
}

// Fixed list of categories to always appear in search filters
const baseCategories = ['Driver', 'Plumber', 'Electrician', 'Carpenter', 'Painter', 'Mechanic'];


// === 5. CORE ROUTES ===

// 5.1 HOME/LANDING PAGE
app.get('/', (req, res) => {
    res.render('index', { title: 'Home' }); 
});

// 5.2 REGISTRATION ROUTES
app.get('/register', (req, res) => {
    res.render('register', { title: 'Register as Provider', error: null });
});

app.post('/register', async (req, res) => {
    const { email, password, name, category, contactInfo, newCategory, profilePictureData, description } = req.body;
    
    let finalCategory = category;
    if (category === 'other' && newCategory && newCategory.trim().length > 0) {
        finalCategory = newCategory.trim().charAt(0).toUpperCase() + newCategory.trim().slice(1).toLowerCase();
    } else if (category === 'other' && (!newCategory || newCategory.trim().length === 0)) {
         return res.render('register', { error: 'Please specify the new category.', title: 'Register' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new User({
            email,
            password: hashedPassword,
            name,
            category: finalCategory,
            contactInfo,
            // Use profilePictureData (Base64) from the file input
            profilePictureUrl: profilePictureData, 
            description,
            role: 'provider',
            isSubscribed: false,
            trialStartDate: new Date()
        });

        await newUser.save();

        req.session.userId = newUser._id;
        // MUST save session explicitly before redirecting
        req.session.save(err => {
            if (err) console.error("Session Save Error:", err);
            res.redirect('/provider/profile'); 
        });
    } catch (error) {
        console.error('Registration Error:', error);
        res.render('register', { error: 'Registration failed. Email may already be in use.', title: 'Register' });
    }
});


// 5.3 LOGIN ROUTES
app.get('/login', (req, res) => {
    res.render('login', { title: 'Provider Login', error: null });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });

        if (!user) {
            return res.render('login', { error: 'Invalid email or password.', title: 'Login' });
        }
        
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
            return res.render('login', { error: 'Invalid email or password.', title: 'Login' });
        }

        // Success: set session and redirect
        req.session.userId = user._id;
        // Must explicitly save the session
        req.session.save(err => {
            if (err) console.error("Session Save Error:", err);
            res.redirect('/provider/profile');
        });

    } catch (error) {
        console.error('Login Error:', error);
        res.render('login', { error: 'An internal error occurred during login.', title: 'Login' });
    }
});

// 5.4 LOGOUT ROUTE
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Logout Error:', err);
            return res.status(500).send('Could not log out.');
        }
        res.redirect('/');
    });
});


// 5.5 PROVIDER PROFILE (SECURE ROUTE)
app.get('/provider/profile', isLoggedIn, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId);
        
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const trialEndDate = new Date(provider.trialStartDate.getTime() + ONE_WEEK_MS);
        const now = new Date();
        
        const isTrialActive = !provider.isSubscribed && now < trialEndDate;
        let daysLeft = 0;
        if (isTrialActive) {
            daysLeft = Math.ceil((trialEndDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        }

        res.render('provider/profile', { 
            title: 'My Profile (Dashboard)', 
            provider,
            isTrialActive,
            daysLeft 
        });
    } catch (error) {
        console.error('Profile Load Error:', error);
        res.status(500).send('Error loading profile.');
    }
});

// 5.5b PROVIDER PROFILE EDIT GET
app.get('/provider/edit', isLoggedIn, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId);
        
        // FIX: Check if provider exists to prevent errors from stale sessions
        if (!provider) {
             req.session.destroy(err => {
                 if (err) console.error('Session Destroy Error:', err);
                 req.session.error = 'Your session is invalid. Please log in again.';
                 res.redirect('/login');
             });
             return;
        }

        res.render('provider/edit-profile', { 
            title: 'Edit Profile', 
            provider,
            baseCategories,
            error: null 
        });
    } catch (error) {
        console.error('Edit Profile Load Error:', error);
        
        // FIX: If Mongoose throws a casting error (invalid ID format), destroy session and redirect
        req.session.destroy(err => {
             if (err) console.error('Session Destroy Error (in catch):', err);
             // Use a flash error message to inform the user why they were logged out
             req.session.error = 'A critical session error occurred. Please log in again.'; 
             res.redirect('/login');
        });
    }
});

// 5.5c PROVIDER PROFILE EDIT POST (FIXED FOR INTERNAL SERVER ERROR)
app.post('/provider/edit', isLoggedIn, async (req, res) => {
    const { name, category, contactInfo, newCategory, profilePictureData, description } = req.body;
    
    let finalCategory = category;
    if (category === 'other' && newCategory && newCategory.trim().length > 0) {
        finalCategory = newCategory.trim().charAt(0).toUpperCase() + newCategory.trim().slice(1).toLowerCase();
    } else if (category === 'other' && (!newCategory || newCategory.trim().length === 0)) {
         // Handle error case for required field when 'other' is selected
         req.session.error = 'Please specify the new category.';
         return res.redirect('/provider/edit');
    }
    
    try {
        const updateData = {
            name,
            category: finalCategory,
            contactInfo,
            profilePictureUrl: profilePictureData, // Update with new Base64 data
            description
        };
        
        // This should prevent the server crash and return an error message
        const result = await User.findByIdAndUpdate(req.session.userId, updateData, { new: true, runValidators: true });
        
        if (!result) {
             throw new Error("User not found during update.");
        }
        
        req.session.message = 'Profile updated successfully!';
        res.redirect('/provider/profile');
    } catch (error) {
        console.error('Profile Update Error (500):', error); // Log the specific error
        
        // Set a user-friendly error message and redirect
        req.session.error = 'Failed to update profile. Please check your data and try again.';
        res.redirect('/provider/edit');
    }
});


// 5.6 SUBSCRIPTION ROUTES
app.get('/subscribe', isLoggedIn, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId);
        res.render('subscribe', { 
            title: 'Subscribe & Pay', 
            provider 
        });
    } catch (error) {
        console.error('Subscribe page load error:', error);
        res.status(500).send('Could not load subscription details.');
    }
});

app.post('/subscribe/activate', isLoggedIn, async (req, res) => {
    try {
        // In a real app, this is where payment processing (Stripe, M-Pesa, etc.) would happen.
        // For now, we manually flip the subscription status.
        await User.findByIdAndUpdate(req.session.userId, { isSubscribed: true }, { new: true });
        
        req.session.message = 'Subscription Activated! You are now visible in search results.';
        res.redirect('/provider/profile'); 
    } catch (error) {
        console.error('Subscription Activation Error:', error);
        req.session.error = 'Failed to activate subscription.';
        res.redirect('/subscribe');
    }
});

// 5.7 SEARCH ROUTES
app.get('/search', async (req, res) => {
    const { query, category } = req.query; 

    // FIX: Defaulting query/category to empty string to prevent EJS ReferenceError
    const q = query || ''; 
    const selectedCategory = category || '';

    let mongoQuery = { isSubscribed: true }; 

    if (selectedCategory && selectedCategory !== 'All Categories') {
        mongoQuery.category = selectedCategory;
    }
    
    if (q) {
        const searchRegex = new RegExp(q, 'i');
        mongoQuery.$or = [
            { name: searchRegex },
            { description: searchRegex } 
        ];
        
        if (selectedCategory) {
             mongoQuery = { $and: [{ category: selectedCategory }, mongoQuery] };
        }
        
    }
    
    const dbCategories = await User.distinct('category', { isSubscribed: true });
    // Combine base categories with subscribed categories for a comprehensive filter list
    const uniqueCategories = [...new Set([...baseCategories, ...dbCategories])].filter(c => c);

    try {
        const providers = await User.find(mongoQuery);
        
        res.render('search-results', { 
            title: 'Search Results', 
            providers, 
            query: q, 
            selectedCategory: selectedCategory, 
            uniqueCategories 
        });
    } catch (error) {
        console.error('Search Error:', error);
        res.render('search-results', { 
            title: 'Search Results', 
            providers: [], 
            query: q, 
            selectedCategory: selectedCategory, 
            uniqueCategories,
            error: 'Failed to perform search.' 
        });
    }
});

// 5.10 PROVIDER VIEW ROUTE (Public, non-authenticated view)
app.get('/provider/view/:id', async (req, res) => {
    try {
        const provider = await User.findById(req.params.id);
        
        if (!provider || !provider.isSubscribed) {
            return res.status(404).send('Service provider not found or subscription inactive.');
        }

        res.render('public-profile', { 
            title: `${provider.name}'s Profile`, 
            provider 
        });
    } catch (error) {
        console.error('Public Profile Load Error:', error);
        res.status(500).send('Error loading public profile.');
    }
});


// 5.8 FORGOT PASSWORD - Form
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { title: 'Forgot Password', error: null, message: null });
});

// 5.9 FORGOT PASSWORD - Process (Placeholder)
app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) {
            req.session.message = 'If an account exists for this email, a password reset link has been sent.'; 
            return res.redirect('/forgot-password');
        }
        console.log(`[PASSWORD RESET] Token link GENERATED for: ${email}`);
        req.session.message = 'If an account exists for this email, a password reset link has been sent.'; 
        return res.redirect('/forgot-password');

    } catch (error) {
        console.error('Forgot Password Error:', error);
        req.session.error = 'An internal error occurred during the request.';
        return res.redirect('/forgot-password');
    }
});

// === 6. START THE SERVER ===
app.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});
