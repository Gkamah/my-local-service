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

// Base categories to ensure they are always available in search filters
const baseCategories = ['Driver', 'Plumbing', 'Electrician', 'Gardening', 'Cleaning'];

// === 2. DATABASE CONNECTION ===
mongoose.connect(process.env.DATABASE_URL)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('DB Connection Error:', err));

// === 3. MIDDLEWARE & VIEW ENGINE SETUP ===

// Trust proxy for secure cookies when running behind services like Render
app.set('trust proxy', 1);

app.set('view engine', 'ejs'); 
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware for parsing application/json and application/x-www-form-urlencoded
// CRITICAL FIX: Increased limit to 50mb to handle large Base64 profile images without crashing
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' })); 

// Express Session Middleware
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        sameSite: 'Lax' // Necessary for cross-site cookie behavior on redirects
    } 
}));

// Global locals for EJS templates (Handles Flash Messages)
app.use((req, res, next) => {
    res.locals.isLoggedIn = !!req.session.userId;
    // Rename to consistent success/error messaging variables for EJS templates
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

// === 5. CORE ROUTES ===

// 5.1 HOME/LANDING PAGE
app.get('/', (req, res) => {
    res.render('index', { title: 'Home' }); 
});

// 5.2 REGISTRATION ROUTES
app.get('/register', (req, res) => {
    res.render('register', { title: 'Register as Provider', error: null, baseCategories: baseCategories });
});

app.post('/register', async (req, res) => {
    // Ensure all required fields, including new ones, are destructured
    const { email, password, name, category, contactInfo, newCategory, profilePictureData, description } = req.body;
    
    let finalCategory = category;
    if (category === 'other' && newCategory && newCategory.trim().length > 0) {
        finalCategory = newCategory.trim().charAt(0).toUpperCase() + newCategory.trim().slice(1).toLowerCase();
    } else if (category === 'other' && (!newCategory || newCategory.trim().length === 0)) {
         return res.render('register', { error: 'Please specify the new category.', title: 'Register', baseCategories: baseCategories });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new User({
            email,
            password: hashedPassword,
            name,
            category: finalCategory,
            contactInfo,
            // CRITICAL: Save initial profile data here
            profilePictureUrl: profilePictureData || '',
            description: description || '',
            role: 'provider',
            isSubscribed: false,
            trialStartDate: new Date()
        });

        await newUser.save();

        req.session.userId = newUser._id;
        req.session.save(err => {
            if (err) console.error('Session save error after register:', err);
            res.redirect('/provider/profile'); 
        });
    } catch (error) {
        console.error('Registration Error:', error);
        res.render('register', { error: 'Registration failed. Email may already be in use.', title: 'Register', baseCategories: baseCategories });
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
        
        // CRITICAL FIX: Explicitly save session before redirecting
        req.session.save(err => {
            if (err) console.error('Session save error after login:', err);
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


// 5.5a PROVIDER PROFILE (SECURE ROUTE - Dashboard)
app.get('/provider/profile', isLoggedIn, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId);

        if (!provider) {
            console.warn(`Session ID found but user not in DB: ${req.session.userId}`);
            return req.session.destroy(() => res.redirect('/login'));
        }
        
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const trialEndDate = new Date(provider.trialStartDate.getTime() + ONE_WEEK_MS);
        const now = new Date();
        
        const isTrialActive = !provider.isSubscribed && now < trialEndDate;
        let daysLeft = 0;
        if (isTrialActive) {
            daysLeft = Math.ceil((trialEndDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        }

        res.render('provider/profile', { 
            title: 'My Dashboard', 
            provider,
            isTrialActive,
            daysLeft 
        });
    } catch (error) {
        // Catch Mongoose CastError (invalid ID format) or other DB errors
        console.error('Profile Load Error:', error);
        req.session.destroy(() => res.redirect('/login')); 
    }
});

// 5.5b PROVIDER EDIT PROFILE (GET)
app.get('/provider/edit', isLoggedIn, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId);

        if (!provider) {
            console.warn(`Session ID found but user not in DB: ${req.session.userId}`);
            return req.session.destroy(() => res.redirect('/login'));
        }
        
        const currentCategory = provider.category;

        res.render('provider/edit-profile', { 
            title: 'Edit Profile', 
            provider,
            baseCategories: baseCategories,
            currentCategory: currentCategory, // Passed to EJS for pre-selection
            error: null
        });
    } catch (error) {
        // Catch Mongoose CastError (invalid ID format) or other DB errors
        console.error('Edit Profile Load Error:', error);
        // Destroy corrupted session and redirect
        req.session.destroy(() => res.redirect('/login')); 
    }
});

// 5.6 PROVIDER EDIT PROFILE (POST)
app.post('/provider/edit', isLoggedIn, async (req, res) => {
    // Ensure all fields are included in destructuring
    const { name, category, contactInfo, newCategory, profilePictureData, description } = req.body;
    
    let finalCategory = category;
    if (category === 'other' && newCategory && newCategory.trim().length > 0) {
        finalCategory = newCategory.trim().charAt(0).toUpperCase() + newCategory.trim().slice(1).toLowerCase();
    } else if (category === 'other' && (!newCategory || newCategory.trim().length === 0)) {
        req.session.error = 'Please specify the new category.';
        return res.redirect('/provider/edit');
    }

    try {
        // CRITICAL FIX: Extract and update profile picture data and description
        const updateFields = {
            name,
            category: finalCategory,
            contactInfo,
            // Save the Base64 string directly
            profilePictureUrl: profilePictureData || '',
            description: description || '' 
        };

        const updatedProvider = await User.findByIdAndUpdate(req.session.userId, updateFields, { new: true });
        
        if (!updatedProvider) {
            req.session.error = 'User profile could not be found for update.';
            return res.redirect('/logout');
        }

        req.session.message = 'Profile updated successfully!';
        res.redirect('/provider/profile');
    } catch (error) {
        console.error('Profile Update Error:', error);
        req.session.error = 'Failed to update profile due to an internal error.';
        res.redirect('/provider/edit');
    }
});


// 5.7 SUBSCRIPTION ROUTES
app.get('/subscribe', isLoggedIn, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId);
        res.render('subscribe', { title: 'Subscribe & Pay', provider });
    } catch (error) {
        console.error('Subscribe page load error:', error);
        req.session.error = 'Could not load subscription details.';
        res.redirect('/provider/profile');
    }
});

app.post('/subscribe/activate', isLoggedIn, async (req, res) => {
    try {
        const updatedProvider = await User.findByIdAndUpdate(
            req.session.userId, 
            { isSubscribed: true }, 
            { new: true }
        );

        if (!updatedProvider) {
            req.session.error = 'Subscription failed. User not found.';
            return res.redirect('/subscribe');
        }

        req.session.message = 'Subscription activated! Your profile is now visible in search results.';
        res.redirect('/provider/profile');
    } catch (error) {
        console.error('Subscription Activation Error:', error);
        req.session.error = 'An error occurred during subscription activation.';
        res.redirect('/subscribe');
    }
});


// 5.8 SEARCH ROUTES
app.get('/search', async (req, res) => {
    const q = req.query.query || '';
    const category = req.query.category || '';

    let query = { isSubscribed: true }; 
    
    // Get all unique categories for the dropdown, ensuring base categories are always included
    let uniqueCategories = [];
    try {
        const dbCategories = await User.distinct('category', { isSubscribed: true });
        uniqueCategories = [...new Set([...baseCategories, ...dbCategories])].sort();
    } catch (error) {
        console.error('Failed to fetch unique categories:', error);
        uniqueCategories = baseCategories; // Fallback
    }

    if (category && category !== 'All Categories' && uniqueCategories.includes(category)) {
        query.category = category;
    }
    
    if (q) {
        const searchRegex = new RegExp(q, 'i');
        query.$or = [
            { name: searchRegex },
            // CRITICAL FIX: Search providers by description as well
            { description: searchRegex },
            { contactInfo: searchRegex }
        ];
    }

    try {
        // This query retrieves all user fields, including profilePictureUrl and description.
        const providers = await User.find(query); 
        res.render('search-results', { 
            title: 'Search Results', 
            providers: providers, 
            uniqueCategories: uniqueCategories,
            query: q, 
            selectedCategory: category 
        });
    } catch (error) {
        console.error('Search Error:', error);
        res.render('search-results', { 
            title: 'Search Results', 
            providers: [], 
            uniqueCategories: uniqueCategories,
            query: q, 
            selectedCategory: category, 
            error: 'Failed to perform search.' 
        });
    }
});

// 5.9 PROVIDER VIEW ROUTE (Public Profile)
app.get('/provider/view/:id', async (req, res) => {
    try {
        const providerId = req.params.id;
        // The provider object returned includes the profilePictureUrl and description
        const provider = await User.findById(providerId); 

        if (!provider || !provider.isSubscribed) {
            return res.status(404).render('404', { title: 'Provider Not Found' });
        }
        
        res.render('public-profile', { 
            title: `${provider.name}'s Profile`, 
            provider
        });
    } catch (error) {
        console.error('Public Profile Load Error:', error);
        res.status(404).render('404', { title: 'Provider Not Found' });
    }
});


// 5.10 FORGOT PASSWORD - Form
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { title: 'Forgot Password', error: null, message: null });
});

// 5.11 FORGOT PASSWORD - Process (Placeholder)
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
