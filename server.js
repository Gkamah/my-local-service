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
// Serve static files (CSS/JS/Images from the 'public' folder)
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
    res.locals.error = req.session.error; // Pass error message
    delete req.session.error; // Clear error after displaying
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
    // 🛑 CAPTURE BOTH 'category' (dropdown value) AND 'newCategory' (text input)
    const { email, password, name, category, contactInfo, newCategory } = req.body;
    
    // LOGIC TO DETERMINE FINAL CATEGORY
    let finalCategory = category;
    if (category === 'other' && newCategory && newCategory.trim().length > 0) {
        // Use the new input value if 'other' was selected
        finalCategory = newCategory.trim().charAt(0).toUpperCase() + newCategory.trim().slice(1).toLowerCase();
    } else if (category === 'other' && (!newCategory || newCategory.trim().length === 0)) {
        // Simple validation check if 'other' was selected but field was left blank
         return res.render('register', { error: 'Please specify the new category.', title: 'Register' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new User({
            email,
            password: hashedPassword,
            name,
            category: finalCategory, // Use the determined category
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

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.render('login', { error: 'Invalid email or password.', title: 'Login' });
        }

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
        if (!provider) {
            return res.redirect('/login');
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


// 5.6 SUBSCRIPTION ROUTE (M-Pesa Integration Point)
app.get('/subscribe', isLoggedIn, (req, res) => {
    res.render('subscribe', { title: 'Subscribe & Pay' });
});


// 5.7 SEARCH ROUTES
app.get('/search', async (req, res) => {
    const { q, category } = req.query;
    let query = { isSubscribed: true }; // ONLY search subscribed users

    // Add filtering by category if provided
    if (category && category !== 'All Categories') {
        query.category = category;
    }
    
    // Add keyword search logic here (optional)
    if (q) {
        const searchRegex = new RegExp(q, 'i'); // Case-insensitive search
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

// === 6. START THE SERVER ===
app.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});