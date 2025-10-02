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

// CRITICAL FIX FOR DEPLOYED SESSIONS: Trust proxy
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

// Express Session Middleware - Updated Cookie Configuration
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        sameSite: 'Lax' 
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

// Define static categories that should always appear in the search filter
const baseCategories = ['Driver', 'Plumber', 'Electrician', 'Carpenter', 'Painter', 'Mechanic']; 

// Default image placeholder (using a generic, widely available placeholder)
const defaultProfilePic = 'https://placehold.co/100x100/1a1a40/ffffff?text=P+P'; 

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
    const { email, password, name, category, contactInfo, newCategory, description, profilePictureUrl } = req.body;
    
    let finalCategory = category;
    if (category === 'other' && newCategory && newCategory.trim().length > 0) {
        finalCategory = newCategory.trim().charAt(0).toUpperCase() + newCategory.trim().slice(1).toLowerCase();
    } else if (category === 'other' && (!newCategory || newCategory.trim().length === 0)) {
         return res.render('register', { error: 'Please specify the new category.', title: 'Register' });
    }
    
    // Use submitted URL or default placeholder
    const finalProfilePic = profilePictureUrl || defaultProfilePic;
    const finalDescription = description || 'A committed service provider.';

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new User({
            email,
            password: hashedPassword,
            name,
            category: finalCategory,
            contactInfo,
            description: finalDescription, // <-- NEW FIELD
            profilePictureUrl: finalProfilePic, // <-- NEW FIELD
            role: 'provider',
            isSubscribed: false,
            trialStartDate: new Date()
        });

        await newUser.save();

        req.session.userId = newUser._id;
        req.session.save(err => {
            if (err) {
                console.error('Session Save Error on Register:', err);
                return res.redirect('/provider/profile'); 
            }
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

        req.session.userId = user._id;
        
        req.session.save(err => {
            if (err) {
                console.error('Session Save Error on Login:', err);
                return res.render('login', { error: 'Failed to establish session. Try again.', title: 'Login' });
            }
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
            title: 'My Profile', 
            provider,
            isTrialActive,
            daysLeft 
        });
    } catch (error) {
        console.error('Profile Load Error:', error);
        res.status(500).send('Error loading profile.');
    }
});

// 5.6 PROVIDER EDIT PROFILE (GET) 
app.get('/provider/edit', isLoggedIn, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId);
        if (!provider) {
            req.session.error = 'User not found.';
            return res.redirect('/provider/profile');
        }
        // Format category for consistent comparison in the select dropdown
        const currentCategory = provider.category.toLowerCase();
        
        res.render('provider/edit-profile', { 
            title: 'Edit Profile', 
            provider: provider,
            currentCategory: currentCategory
        });
    } catch (error) {
        console.error('Edit Profile Load Error:', error);
        req.session.error = 'Error loading edit form.';
        res.redirect('/provider/profile');
    }
});

// 5.7 PROVIDER UPDATE PROFILE (POST) 
app.post('/provider/edit', isLoggedIn, async (req, res) => {
    const { name, category, contactInfo, newCategory, description, profilePictureUrl } = req.body; // <-- ADD NEW FIELDS
    let finalCategory = category;

    // Handle "Other" category update logic
    if (category === 'other' && newCategory && newCategory.trim().length > 0) {
        finalCategory = newCategory.trim().charAt(0).toUpperCase() + newCategory.trim().slice(1).toLowerCase();
    } else if (category === 'other' && (!newCategory || newCategory.trim().length === 0)) {
        req.session.error = 'Please specify the new category.';
        return res.redirect('/provider/edit');
    }
    
    // Sanitize profile pic URL and description
    const finalProfilePic = profilePictureUrl && profilePictureUrl.trim().length > 0 ? profilePictureUrl.trim() : defaultProfilePic;
    const finalDescription = description || 'A committed service provider.';


    try {
        await User.findByIdAndUpdate(req.session.userId, {
            name,
            category: finalCategory,
            contactInfo,
            description: finalDescription, // <-- UPDATE FIELD
            profilePictureUrl: finalProfilePic // <-- UPDATE FIELD
        }, { new: true, runValidators: true });

        req.session.message = 'Profile updated successfully!';
        res.redirect('/provider/profile');

    } catch (error) {
        console.error('Profile Update Error:', error);
        req.session.error = 'Failed to update profile due to a server error.';
        res.redirect('/provider/edit');
    }
});

// 5.8 SUBSCRIPTION ROUTE (GET)
app.get('/subscribe', isLoggedIn, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId);
        if (!provider) {
            req.session.error = 'User not found.';
            return res.redirect('/provider/profile');
        }
        res.render('subscribe', { title: 'Activate Subscription', provider });
    } catch (error) {
        console.error('Subscribe Load Error:', error);
        req.session.error = 'Error loading subscription page.';
        res.redirect('/provider/profile');
    }
});

// 5.9 SUBSCRIPTION ACTIVATION (POST Placeholder)
app.post('/subscribe/activate', isLoggedIn, async (req, res) => {
    try {
        // NOTE: In a real app, this is where payment processing (Stripe/PayPal) would happen.
        // For now, we manually flip the subscribed status.
        await User.findByIdAndUpdate(req.session.userId, { isSubscribed: true }, { new: true });

        req.session.message = 'Subscription successfully activated! Your profile is now visible in search results.';
        res.redirect('/provider/profile');
    } catch (error) {
        console.error('Subscription Activation Error:', error);
        req.session.error = 'Failed to activate subscription.';
        res.redirect('/subscribe');
    }
});

// 5.10 PROVIDER VIEW ROUTE (For search results click: Public Profile)
app.get('/provider/view/:id', async (req, res) => {
    try {
        const providerId = req.params.id;
        const provider = await User.findById(providerId);

        if (!provider || !provider.isSubscribed) {
            req.session.error = 'Provider not found or not currently subscribed.';
            return res.redirect('/search');
        }

        // Renders the detailed public profile view
        res.render('public-profile', { 
            title: `${provider.name}'s Profile`, 
            provider: provider,
        });

    } catch (error) {
        console.error('Public Profile View Error:', error);
        req.session.error = 'Error loading provider profile.';
        res.redirect('/search');
    }
});


// 5.11 SEARCH ROUTES -- UPDATED FOR DYNAMIC CATEGORIES
app.get('/search', async (req, res) => {
    const { q, category } = req.query;
    let query = { isSubscribed: true }; 

    if (category && category !== 'All Categories') {
        query.category = category;
    }
    
    if (q) {
        const searchRegex = new RegExp(q, 'i');
        query.$or = [
            { name: searchRegex },
            { category: searchRegex },
            { contactInfo: searchRegex }
        ];
    }

    try {
        // 1. Fetch all unique categories from subscribed users
        const dynamicCategories = await User.distinct('category', { isSubscribed: true });
        
        // Combine base categories and dynamic categories, ensuring uniqueness
        let categoriesList = new Set([...baseCategories, ...dynamicCategories]);
        
        // Convert back to an array for EJS, filter out any potential empty strings, and sort
        const uniqueCategories = Array.from(categoriesList)
            .filter(cat => cat && cat.trim().length > 0)
            .sort();
        
        // Always put 'All Categories' at the top
        uniqueCategories.unshift('All Categories');
        
        // 2. Perform the main search query
        const providers = await User.find(query);
        
        // 3. Render the view, passing the unique categories
        res.render('search-results', { 
            title: 'Search Results', 
            providers, 
            q: q || '', 
            category: category || '',
            uniqueCategories // <-- PASSING NEW DATA
        });
    } catch (error) {
        console.error('Search Error:', error);
        // Ensure error rendering passes an empty array and the categories to prevent crash
        const uniqueCategories = ['All Categories', ...baseCategories]; 
        res.render('search-results', { 
            title: 'Search Results', 
            providers: [], 
            q: q || '', 
            category: category || '', 
            error: 'Failed to perform search.',
            uniqueCategories
        });
    }
});

// 5.12 FORGOT PASSWORD - Form
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { title: 'Forgot Password', error: null, message: null });
});

// 5.13 FORGOT PASSWORD - Process (Placeholder for sending email/token)
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
