// server.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcrypt');

// Load environment variables (MUST be the first thing!)
dotenv.config();

// === Mongoose Schema Definition ===
// Define the Mongoose User Model directly in the server file for simplicity
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['provider', 'user'], default: 'provider' },
    // Provider specific fields
    name: { type: String, required: function() { return this.role === 'provider'; } },
    contactInfo: { type: String },
    category: { type: String },
    
    // FIELDS for Profile Picture and Description
    description: { type: String, default: '' }, 
    profilePictureUrl: { type: String, default: '' },
    
    // NEW FIELD for Reviews/Inquiries
    reviews: [{
        visitorName: { type: String, required: true },
        rating: { type: Number, default: 0 }, // 0 for inquiry, 1-5 for review
        comment: { type: String, required: true },
        date: { type: Date, default: Date.now }
    }]
});

// Hash the password before saving
UserSchema.pre('save', async function(next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});

const User = mongoose.model('User', UserSchema);

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

// Middleware for parsing large JSON and URL-encoded bodies
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' })); 

// Express Session Middleware
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: app.get('env') === 'production', // Use secure cookies in production
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    } 
}));

// Middleware to set local variables (user session data, messages)
app.use((req, res, next) => {
    // Session state
    res.locals.isLoggedIn = req.session.userId ? true : false;
    res.locals.isProvider = req.session.userRole === 'provider';
    res.locals.userEmail = req.session.userEmail || null;
    
    // Flash messages
    res.locals.error = req.session.error;
    delete req.session.error;
    res.locals.message = req.session.message;
    delete req.session.message;
    
    next();
});

// Middleware to ensure user is logged in
const isAuthenticated = (req, res, next) => {
    if (!req.session.userId) {
        req.session.error = 'You must be logged in to access this page.';
        return res.redirect('/login');
    }
    next();
};

// Middleware to ensure user is a provider
const isProvider = (req, res, next) => {
    if (req.session.userRole !== 'provider') {
        req.session.error = 'Access denied. Only service providers can access this page.';
        return res.redirect('/');
    }
    next();
};

// === 4. PUBLIC ROUTES ===

// 4.1 HOME & SEARCH
app.get('/', async (req, res) => {
    // Fetch all unique categories for the search filter
    const uniqueCategories = [...baseCategories, ...await User.distinct('category', { role: 'provider' })].filter(Boolean);
    
    res.render('index', { 
        title: 'Home - Find Local Services', 
        uniqueCategories 
    });
});

// 4.2 SEARCH RESULTS
app.get('/search', async (req, res) => {
    const { query, category } = req.query;
    let filter = { role: 'provider' };
    
    // Add text search filter
    if (query) {
        const regex = new RegExp(query, 'i');
        filter.$or = [
            { name: regex },
            { contactInfo: regex },
            { description: regex }
        ];
    }
    
    // Add category filter
    if (category && category !== 'All Categories') {
        filter.category = category;
    }
    
    try {
        const providers = await User.find(filter).select('-password');
        
        // Fetch all unique categories again for the filter dropdown
        const uniqueCategories = [...baseCategories, ...await User.distinct('category', { role: 'provider' })].filter(Boolean);
        
        res.render('search-results', {
            title: 'Search Results',
            providers,
            query: query || '',
            uniqueCategories,
            selectedCategory: category || 'All Categories'
        });
        
    } catch (error) {
        console.error('Search Error:', error);
        res.render('search-results', {
            title: 'Search Results',
            providers: [],
            query: query || '',
            uniqueCategories: baseCategories,
            selectedCategory: category || 'All Categories',
            error: 'An error occurred during search. Please try again.'
        });
    }
});


// 4.3 LOGIN - Form
app.get('/login', (req, res) => {
    res.render('login', { title: 'Login' });
});

// 4.4 LOGIN - Process
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await User.findOne({ email });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            req.session.error = 'Invalid email or password.';
            return res.redirect('/login');
        }

        // Set session
        req.session.userId = user._id;
        req.session.userRole = user.role;
        req.session.userEmail = user.email;

        // Redirect based on role
        if (user.role === 'provider') {
            req.session.message = `Welcome back, ${user.name}!`;
            return res.redirect('/provider/profile');
        } else {
            // Future-proofing for regular users
            req.session.message = 'Logged in successfully.';
            return res.redirect('/');
        }
        
    } catch (error) {
        console.error('Login Error:', error);
        req.session.error = 'An internal error occurred during login.';
        res.redirect('/login');
    }
});

// 4.5 LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Logout Error:', err);
        }
        res.redirect('/');
    });
});

// 4.6 REGISTER - Form
app.get('/register', (req, res) => {
    res.render('register', { title: 'Register', baseCategories });
});

// 4.7 REGISTER - Process
app.post('/register', async (req, res) => {
    const { name, email, password, contactInfo, category } = req.body;
    
    try {
        const newUser = new User({
            name,
            email,
            password,
            contactInfo,
            category,
            role: 'provider', // Hardcoded registration as provider
        });
        await newUser.save();
        
        // Auto-login after successful registration
        req.session.userId = newUser._id;
        req.session.userRole = newUser.role;
        req.session.userEmail = newUser.email;

        req.session.message = 'Registration successful! Welcome to your dashboard.';
        res.redirect('/provider/profile');
        
    } catch (error) {
        console.error('Registration Error:', error);
        if (error.code === 11000) { // MongoDB duplicate key error (E11000)
             req.session.error = 'This email is already registered.';
        } else {
             req.session.error = 'An internal error occurred during registration.';
        }
        res.redirect('/register');
    }
});

// === 5. PROVIDER DASHBOARD ROUTES (REQUIRES AUTH) ===

// 5.1 PROVIDER PROFILE - View Dashboard
app.get('/provider/profile', isAuthenticated, isProvider, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId).select('-password');
        
        if (!provider) {
            req.session.error = 'Provider profile not found.';
            return res.redirect('/logout');
        }
        
        res.render('provider-profile', { 
            title: `${provider.name}'s Dashboard`, 
            provider,
            baseCategories 
        });
        
    } catch (error) {
        console.error('Profile Load Error:', error);
        req.session.error = 'An error occurred while loading your profile.';
        res.redirect('/');
    }
});


// 5.2 PROVIDER EDIT - Form
app.get('/provider/profile/edit', isAuthenticated, isProvider, async (req, res) => {
    try {
        const provider = await User.findById(req.session.userId).select('-password');
        
        if (!provider) {
            req.session.error = 'Provider profile not found.';
            return res.redirect('/logout');
        }
        
        // Ensure base categories are available
        const uniqueCategories = [...baseCategories, ...await User.distinct('category', { role: 'provider' })].filter(Boolean);
        
        res.render('provider-edit', { 
            title: `Edit ${provider.name}'s Profile`, 
            provider,
            uniqueCategories: uniqueCategories
        });
        
    } catch (error) {
        console.error('Edit Form Load Error:', error);
        req.session.error = 'An error occurred while loading the edit form.';
        res.redirect('/provider/profile');
    }
});


// 5.3 PROVIDER EDIT - Process
app.post('/provider/edit', isAuthenticated, isProvider, async (req, res) => {
    try {
        const { 
            name, 
            contactInfo, 
            category, 
            description,
            profilePictureData
        } = req.body;

        const updateData = {
            name,
            contactInfo,
            category,
            description: description || '', 
        };

        // Only update the profile picture if new data was provided
        if (profilePictureData && profilePictureData.length > 0) {
            updateData.profilePictureUrl = profilePictureData;
        }

        await User.findByIdAndUpdate(req.session.userId, updateData, { new: true });

        req.session.message = 'Profile updated successfully!';
        res.redirect('/provider/profile');
    } catch (error) {
        console.error('Profile Update Error:', error);
        req.session.error = 'An error occurred while updating the profile.';
        res.redirect('/provider/profile/edit');
    }
});


// 5.4 NEW FEATURE: Review and Inquiry Submission Route
app.post('/provider/review/:id', async (req, res) => {
    const providerId = req.params.id;
    const { visitorName, rating, comment } = req.body;

    // Basic validation
    if (!visitorName || !comment) {
        req.session.reviewError = 'Please provide your name and a message/review.';
        return res.redirect(`/provider/view/${providerId}`);
    }

    try {
        const provider = await User.findById(providerId);

        if (!provider) {
            req.session.reviewError = 'Provider not found.';
            return res.status(404).redirect('/');
        }
        
        // Prepare the new entry
        const newEntry = {
            visitorName,
            // Convert rating to Number. Default to 0 if not provided/invalid.
            rating: parseInt(rating) || 0, 
            comment,
            date: new Date()
        };

        // Use $push to add the new review/inquiry to the reviews array
        await User.findByIdAndUpdate(providerId, { 
            $push: { reviews: newEntry } 
        });

        // Set success message based on whether a rating was provided
        req.session.reviewMessage = newEntry.rating > 0
            ? 'Thank you! Your review has been submitted and is now visible.' 
            : 'Thank you! Your inquiry has been sent to the provider.';
            
        // Redirect back to the public profile to show the new review/message
        res.redirect(`/provider/view/${providerId}`);

    } catch (error) {
        console.error('Review submission error:', error);
        req.session.reviewError = 'An internal error occurred while submitting your review/inquiry.';
        res.redirect(`/provider/view/${providerId}`);
    }
});


// 5.5 PROVIDER VIEW ROUTE (Public Profile) - MODIFIED TO HANDLE FLASH MESSAGES
app.get('/provider/view/:id', async (req, res) => {
    // --- START Flash Message Handling ---
    const reviewMessage = req.session.reviewMessage;
    const reviewError = req.session.reviewError;
    // Delete the session variables immediately after reading them
    delete req.session.reviewMessage;
    delete req.session.reviewError;
    // --- END Flash Message Handling ---
    
    try {
        const providerId = req.params.id;
        // Use .lean() for faster read and retrieve all data including reviews
        const provider = await User.findById(providerId).select('-password').lean();

        if (!provider || provider.role !== 'provider') {
            return res.status(404).render('404', { title: 'Provider Not Found' });
        }
        
        // Renders the public-profile.ejs file with the provider data
        res.render('public-profile', { 
            title: `${provider.name}'s Profile`, 
            provider,
            reviewMessage, // Pass message
            reviewError    // Pass error
        });
    } catch (error) {
        console.error('Public Profile Load Error:', error);
        res.status(404).render('404', { title: 'Provider Not Found' });
    }
});


// 5.6 FORGOT PASSWORD - Form
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { title: 'Forgot Password' });
});

// 5.7 FORGOT PASSWORD - Process (Placeholder)
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

// 6. CATCH-ALL 404
app.use((req, res) => {
    res.status(404).render('404', { title: 'Page Not Found' });
});

// === 7. START THE SERVER ===
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
