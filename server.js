// server.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcrypt');

// Load environment variables (MUST be the first thing!)
dotenv.config();

// ⚠️ SAFETY CHECKS: Provide fallbacks for essential environment variables
if (!process.env.SESSION_SECRET) {
    console.warn("⚠️ WARNING: SESSION_SECRET not set. Using a temporary fallback secret.");
    process.env.SESSION_SECRET = 'a-super-secret-fallback-key-for-dev';
}
if (!process.env.DATABASE_URL) {
    console.warn("⚠️ WARNING: DATABASE_URL not set. Using a fallback local MongoDB URL.");
    process.env.DATABASE_URL = 'mongodb://localhost:27017/local_service_finder';
}

// === Mongoose Schema Definition (Self-Contained in server.js) ===
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
// Ensure PORT is correctly read from environment or defaults to 3000
const PORT = process.env.PORT || 3000; 

// Base categories to ensure they are always available in search filters
const baseCategories = ['Driver', 'Plumbing', 'Electrician', 'Gardening', 'Cleaning'];

// === 2. DATABASE CONNECTION ===
mongoose.connect(process.env.DATABASE_URL)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('DB Connection Error: Failed to connect to MongoDB. Check DATABASE_URL.', err));

// === 3. MIDDLEWARE & VIEW ENGINE SETUP ===

// Trust proxy for secure cookies when running behind services like Render
app.set('trust proxy', 1);

app.set('view engine', 'ejs'); 
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware for parsing application/json and application/x-www-form-urlencoded
// Increased limit for potential Base64 image data
app.use(express.json({ limit: '5mb' })); 
app.use(express.urlencoded({ extended: true, limit: '5mb' })); 

// Express Session Middleware
app.use(session({
    secret: process.env.SESSION_SECRET, // Using the (potentially fallback) secret
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));


// Global view locals for displaying messages
app.use((req, res, next) => {
    res.locals.isLoggedIn = req.session.isLoggedIn || false;
    res.locals.userRole = req.session.role || null;
    res.locals.userName = req.session.userName || 'Guest';
    res.locals.userId = req.session.userId || null; 

    // Flash messages
    res.locals.error = req.session.error;
    res.locals.message = req.session.message;
    delete req.session.error;
    delete req.session.message;
    next();
});

// === 4. AUTHENTICATION & AUTHORIZATION MIDDLEWARE ===

const ensureAuth = (req, res, next) => {
    if (req.session.isLoggedIn) {
        return next();
    }
    req.session.error = 'You must be logged in to access this page.';
    res.redirect('/login');
};

const ensureProviderAuth = (req, res, next) => {
    if (req.session.isLoggedIn && req.session.role === 'provider') {
        return next();
    }
    req.session.error = 'You must be logged in as a Provider to access this page.';
    res.redirect('/login');
};


// === 5. ROUTES ===

// 5.1 HOME/SEARCH
app.get('/', async (req, res) => {
    const { category, search } = req.query;
    let query = { role: 'provider' }; 
    
    if (category && baseCategories.includes(category)) {
        query.category = category;
    }
    
    if (search && search.length > 0) {
        query.$or = [
            { name: { $regex: search, $options: 'i' } }, 
            { description: { $regex: search, $options: 'i' } } 
        ];
    }
    
    try {
        if (mongoose.connection.readyState !== 1) {
            console.error('Database not connected. Cannot fulfill request.');
            throw new Error('Database connection issue.');
        }

        const providers = await User.find(query).select('-password');
        
        const providersWithStats = providers.map(p => {
            const ratings = p.reviews.filter(r => r.rating >= 1 && r.rating <= 5);
            const totalRating = ratings.reduce((sum, r) => sum + r.rating, 0);
            const averageRating = ratings.length > 0 ? (totalRating / ratings.length).toFixed(1) : 'N/A';
            
            return {
                ...p.toObject(),
                averageRating,
                reviewCount: ratings.length
            };
        });

        providersWithStats.sort((a, b) => {
            const ratingA = a.averageRating === 'N/A' ? -1 : parseFloat(a.averageRating);
            const ratingB = b.averageRating === 'N/A' ? -1 : parseFloat(b.averageRating);
            return ratingB - ratingA; 
        });


        res.render('index', { 
            title: 'Find Trusted Local Services', 
            providers: providersWithStats,
            categories: baseCategories, 
            currentCategory: category || '',
            currentSearch: search || ''
        });
    } catch (error) {
        console.error('Home Page Load Error (Database query failure):', error);
        res.status(500).render('404', { title: 'Server Error', categories: baseCategories }); 
    }
});


// 5.2 LOGIN - Form
app.get('/login', (req, res) => {
    res.render('login', { title: 'Login' });
});

// 5.3 LOGIN - Process
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const user = await User.findOne({ email });
        
        if (!user || !(await bcrypt.compare(password, user.password))) {
            req.session.error = 'Invalid email or password.';
            return res.redirect('/login');
        }
        
        req.session.isLoggedIn = true;
        req.session.userId = user._id;
        req.session.role = user.role;
        req.session.userName = user.name; 
        
        req.session.message = `Welcome back, ${user.name}!`;
        
        if (user.role === 'provider') {
            return res.redirect('/provider/dashboard');
        } else {
            return res.redirect('/');
        }
        
    } catch (error) {
        console.error('Login Error:', error);
        req.session.error = 'An internal error occurred during login.';
        return res.redirect('/login');
    }
});

// 5.4 LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Session Destruction Error:', err);
            return res.status(500).send('Could not log out.');
        }
        res.clearCookie('connect.sid'); 
        res.redirect('/');
    });
});


// 5.5 EDITABLE PROVIDER PROFILE - GET (FIXED ROUTE)
app.get('/provider/profile', ensureProviderAuth, async (req, res) => {
    try {
        const providerId = req.session.userId;
        const provider = await User.findById(providerId).select('-password'); 

        if (!provider || provider.role !== 'provider') {
            req.session.error = 'Your provider account could not be found.';
            return res.redirect('/');
        }
        
        // Renders the editable profile view
        res.render('provider-profile', { 
            title: 'Edit Your Profile', 
            provider: provider.toObject() // Pass the full provider object
        });
    } catch (error) {
        console.error('Editable Profile Load Error:', error);
        req.session.error = 'An error occurred while loading the profile editor.';
        res.redirect('/provider/dashboard');
    }
});


// 5.6 EDITABLE PROVIDER PROFILE - POST (Handle updates)
app.post('/provider/profile', ensureProviderAuth, async (req, res) => {
    const providerId = req.session.userId;
    const { name, category, contactInfo, description, profilePictureUrl } = req.body;

    try {
        const updatedProvider = await User.findByIdAndUpdate(providerId, {
            name,
            category,
            contactInfo,
            description,
            profilePictureUrl, // This stores the Base64 image data
        }, { new: true });

        if (!updatedProvider) {
            req.session.error = 'Profile update failed. Provider not found.';
            return res.redirect('/provider/dashboard');
        }

        // Update the session name in case the provider changed it
        req.session.userName = updatedProvider.name; 
        req.session.message = 'Your profile has been successfully updated!';
        res.redirect('/provider/dashboard');

    } catch (error) {
        console.error('Profile Update Error:', error);
        req.session.error = 'An error occurred while saving your profile changes.';
        res.redirect('/provider/profile'); // Redirect back to editor to fix issues
    }
});


// 5.7 PUBLIC PROVIDER PROFILE - View by ID
app.get('/provider/profile/:id', async (req, res) => {
    const providerId = req.params.id;
    const reviewMessage = req.session.reviewMessage; 
    const reviewError = req.session.reviewError;
    delete req.session.reviewMessage; 
    delete req.session.reviewError;

    try {
        const provider = await User.findById(providerId).select('-password'); 

        if (!provider || provider.role !== 'provider') {
            return res.status(404).render('404', { title: 'Provider Not Found', categories: baseCategories });
        }

        const ratings = provider.reviews.filter(r => r.rating >= 1 && r.rating <= 5);
        const totalRating = ratings.reduce((sum, r) => sum + r.rating, 0);
        const averageRating = ratings.length > 0 ? (totalRating / ratings.length).toFixed(1) : 'N/A';
        const reviewCount = ratings.length;

        res.render('public-profile', { 
            title: `${provider.name}'s Profile`, 
            provider: { ...provider.toObject(), averageRating, reviewCount }, 
            reviewMessage, 
            reviewError    
        });
    } catch (error) {
        console.error('Public Profile Load Error:', error);
        res.status(404).render('404', { title: 'Provider Not Found', categories: baseCategories });
    }
});


// 5.8 NEW ROUTE: POST Review/Inquiry
app.post('/provider/review/:id', async (req, res) => {
    const providerId = req.params.id;
    const { visitorName, rating, comment } = req.body;
    let ratingValue = parseInt(rating, 10) || 0; 

    if (!visitorName || !comment || visitorName.trim().length === 0 || comment.trim().length === 0) {
        req.session.reviewError = 'Name and comment are required.';
        return res.redirect(`/provider/profile/${providerId}`);
    }
    
    if (ratingValue > 5) ratingValue = 5;

    try {
        const provider = await User.findById(providerId);

        if (!provider || provider.role !== 'provider') {
            req.session.reviewError = 'Provider not found.';
            return res.redirect(`/provider/profile/${providerId}`);
        }
        
        provider.reviews.push({
            visitorName,
            rating: ratingValue,
            comment,
            date: new Date()
        });

        await provider.save();
        
        req.session.reviewMessage = ratingValue > 0 
            ? 'Thank you for your review! It has been posted.'
            : 'Thank you for your inquiry. The provider will be in touch!';

        res.redirect(`/provider/profile/${providerId}`);

    } catch (error) {
        console.error('Review Submission Error:', error);
        req.session.reviewError = 'An error occurred while submitting your feedback.';
        res.redirect(`/provider/profile/${providerId}`);
    }
});


// 5.9 REGISTRATION - Form (Ensures categories is passed)
app.get('/register', (req, res) => {
    res.render('register', { title: 'Register', categories: baseCategories });
});

// 5.10 REGISTRATION - Process
app.post('/register', async (req, res) => {
    const { name, email, password, role, category, contactInfo, description } = req.body;
    
    if (!email || !password || (role === 'provider' && (!name || !category))) {
        req.session.error = 'Missing required fields.';
        return res.redirect('/register');
    }

    try {
        const newUser = new User({
            email,
            password,
            role,
            name: role === 'provider' ? name : 'User',
            category: role === 'provider' ? category : undefined,
            contactInfo: role === 'provider' ? contactInfo : undefined,
            description: role === 'provider' ? description : undefined,
        });

        await newUser.save();
        
        req.session.message = 'Registration successful! Please log in.';
        res.redirect('/login');

    } catch (error) {
        if (error.code === 11000) {
            req.session.error = 'This email is already registered.';
            return res.redirect('/register');
        }
        console.error('Registration Error:', error);
        req.session.error = 'An internal error occurred during registration.';
        return res.redirect('/register');
    }
});


// 5.11 PROVIDER DASHBOARD (Requires provider data)
app.get('/provider/dashboard', ensureProviderAuth, async (req, res) => {
    try {
        const providerId = req.session.userId;
        const provider = await User.findById(providerId).select('-password');

        if (!provider) {
             req.session.error = 'Your provider account could not be found.';
             return res.redirect('/');
        }
        
        const ratings = provider.reviews.filter(r => r.rating >= 1 && r.rating <= 5);
        const totalRating = ratings.reduce((sum, r) => sum + r.rating, 0);
        const averageRating = ratings.length > 0 ? (totalRating / ratings.length).toFixed(1) : 'N/A';
        const reviewCount = ratings.length;

        res.render('provider-dashboard', { 
            title: 'Provider Dashboard',
            provider: { ...provider.toObject(), averageRating, reviewCount }
        });
    } catch (error) {
        console.error('Provider Dashboard Load Error:', error);
        req.session.error = 'An error occurred while loading your dashboard.';
        res.redirect('/');
    }
});


// 5.12 FORGOT PASSWORD - Form
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { title: 'Forgot Password' });
});

// 5.13 FORGOT PASSWORD - Process (Placeholder)
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
    res.status(404).render('404', { 
        title: 'Page Not Found', 
        categories: baseCategories // Added to prevent template errors
    });
});


// === 7. START THE SERVER (FIXED) ===
// Render and similar platforms require the app to listen on the PORT environment variable.
app.listen(PORT, () => {
    console.log(`✅ Server running and listening on port ${PORT}`);
    console.log('Environment:', process.env.NODE_ENV || 'development');
});
