// server.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcrypt'); // Required for password hashing
const User = require('./models/User'); // Mongoose User Model

// Load environment variables (from .env locally, from Render remotely)
dotenv.config();

// === 1. INITIALIZE APP & PORT ===
const app = express(); 
const PORT = process.env.PORT || 3000; 

// === 2. DATABASE CONNECTION ===
mongoose.connect(process.env.DATABASE_URL)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('DB Connection Error:', err));

// === 3. MIDDLEWARE & VIEW ENGINE SETUP ===
// Set EJS as the view engine and specify the views directory
app.set('view engine', 'ejs'); 
app.set('views', path.join(__dirname, 'views'));

// Serve static files (CSS/JS/Images from the 'public' folder)
app.use(express.static(path.join(__dirname, 'public')));

// Body Parsers & Session Setup
app.use(express.json()); // To parse JSON bodies
app.use(express.urlencoded({ extended: true })); // To parse form submissions

// Express Session Middleware
app.use(session({
    secret: process.env.SESSION_SECRET, // Crucial for security
    resave: false,
    saveUninitialized: false,
    cookie: { 
        // Use secure cookies in production (HTTPS)
        secure: process.env.NODE_ENV === 'production', 
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    } 
}));

// Global variable for checking login status in EJS templates
app.use((req, res, next) => {
    res.locals.isLoggedIn = !!req.session.userId;
    next();
});

// === 4. AUTH MIDDLEWARE === 
// Protects routes that only logged-in users (providers) should access
function isLoggedIn(req, res, next) {
    if (req.session.userId) {
        return next();
    }
    // Redirect unauthenticated users to the login page
    res.redirect('/login');
}

// === 5. CORE ROUTES ===

// 5.1 HOME/LANDING PAGE
app.get('/', (req, res) => {
    // Renders the main landing page
    res.render('index', { title: 'Home' }); 
});

// 5.2 REGISTRATION ROUTES
app.get('/register', (req, res) => {
    res.render('register', { title: 'Register as Provider' });
});

app.post('/register', async (req, res) => {
    const { email, password, name, category, contactInfo } = req.body;
    try {
        // 1. Hash the password before saving
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // 2. Create the new user/provider
        const newUser = new User({
            email,
            password: hashedPassword,
            name,
            category,
            contactInfo,
            role: 'provider',
            isSubscribed: false, // Start unverified/unsubscribed
            trialStartDate: new Date() // Start the 7-day trial period
        });

        await newUser.save();

        // 3. Automatically log in the user after registration
        req.session.userId = newUser._id;
        res.redirect('/provider/profile'); 
    } catch (error) {
        console.error('Registration Error:', error);
        // Handle unique email constraint or other errors
        res.render('register', { error: 'Registration failed. Email may already be in use.' });
    }
});


// 5.3 LOGIN ROUTES
app.get('/login', (req, res) => {
    res.render('login', { title: 'Provider Login' });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });

        if (!user) {
            return res.render('login', { error: 'Invalid email or password.' });
        }

        // Compare the submitted password with the hashed password in the DB
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.render('login', { error: 'Invalid email or password.' });
        }

        // Login successful: set session and redirect
        req.session.userId = user._id;
        res.redirect('/provider/profile'); 

    } catch (error) {
        console.error('Login Error:', error);
        res.render('login', { error: 'An internal error occurred during login.' });
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
// Use the isLoggedIn middleware to protect this route
app.get('/provider/profile', isLoggedIn, async (req, res) => {
    try {
        // Fetch the logged-in user's data
        const provider = await User.findById(req.session.userId);
        if (!provider) {
            return res.redirect('/login');
        }

        // Logic to determine trial status
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const trialEndDate = new Date(provider.trialStartDate.getTime() + ONE_WEEK_MS);
        const isTrialActive = !provider.isSubscribed && new Date() < trialEndDate;
        const daysLeft = Math.ceil((trialEndDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));


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


// 5.6 SUBSCRIPTION/PAYMENT ROUTE (Placeholder - requires M-Pesa integration)
app.get('/subscribe', isLoggedIn, (req, res) => {
    res.render('subscribe', { title: 'Subscribe & Pay' });
});


// 5.7 SEARCH ROUTES (Placeholder - implementation needed)
app.get('/search', (req, res) => {
    // In the future, this will run a MongoDB query based on req.query
    res.render('search-results', { title: 'Search Results', providers: [] });
});

// === 6. START THE SERVER ===
app.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});