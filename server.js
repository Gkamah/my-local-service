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
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
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
    const { email, password, name, category, contactInfo, newCategory } = req.body;
    
    let finalCategory = category;
    if (category === 'other' && newCategory && newCategory.trim().length > 0) {
        finalCategory = newCategory.trim().charAt(0).toUpperCase() + newCategory.trim().slice(1).toLowerCase();
    } else if (category === 'other' && (!newCategory || newCategory.trim().length === 0)) {
         return res.render('register', { error: 'Please specify the new category.', title: 'Register' });
    }

    try {
        // HASHING STEP: Explicitly setting salt rounds to 10 for consistency
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new User({
            email,
            password: hashedPassword,
            name,
            category: finalCategory,
            contactInfo,
            role: 'provider',
            isSubscribed: false,
            trialStartDate: new Date()
        });

        await newUser.save();

        req.session.userId = newUser._id;
        res.redirect('/provider/profile'); 
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

        // CRITICAL LOGIN LOGIC CHECK: 
        if (!user) {
            return res.render('login', { error: 'Invalid email or password.', title: 'Login' });
        }
        
        // AWAITED PASSWORD COMPARISON
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
            return res.render('login', { error: 'Invalid email or password.', title: 'Login' });
        }

        // Success: set session and redirect
        req.session.userId = user._id;
        res.redirect('/provider/profile'); 

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


// 5.6 SUBSCRIPTION ROUTE 
app.get('/subscribe', isLoggedIn, (req, res) => {
    res.render('subscribe', { title: 'Subscribe & Pay' });
});


// 5.7 SEARCH ROUTES
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
        const providers = await User.find(query);
        res.render('search-results', { 
            title: 'Search Results', 
            providers, 
            q: q || '', 
            category: category || '' 
        });
    } catch (error) {
        console.error('Search Error:', error);
        res.render('search-results', { 
            title: 'Search Results', 
            providers: [], 
            q: q || '', 
            category: category || '', 
            error: 'Failed to perform search.' 
        });
    }
});

// 5.8 FORGOT PASSWORD - Form
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { title: 'Forgot Password', error: null, message: null });
});

// 5.9 FORGOT PASSWORD - Process (Placeholder for sending email/token)
app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    
    try {
        const user = await User.findOne({ email });
        
        if (!user) {
            req.session.message = 'If an account exists for this email, a password reset link has been sent.'; 
            return res.redirect('/forgot-password');
        }
        
        // --- REAL-WORLD: Generate Token, Save to DB, Send Email ---
        
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
