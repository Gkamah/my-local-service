// All necessary imports
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware for parsing request body and session management
app.use(express.urlencoded({ extended: true }));
// CRITICAL FIX: Increase limit for Base64 image data to prevent server crash on large uploads
app.use(express.json({ limit: '50mb' })); 

// 1. Database Connection (using MONGODB_URI)
const MONGODB_URI = process.env.MONGODB_URI; 

// Warning about session store in production
console.warn("WARNING: Using default MemoryStore for sessions. This is not suitable for production and will cause issues.");

// CRITICAL CHECK: Ensure MONGODB_URI is defined
if (!MONGODB_URI) {
    console.error('FATAL ERROR: MONGODB_URI environment variable is not set.');
    // Exit process to prevent Mongoose crash and signal configuration issue
    process.exit(1); 
}

mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('MongoDB connection error:', err));

// 2. Mongoose Schemas and Models
const providerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    contactInfo: String,
    category: { type: String, default: 'General' },
    profilePictureUrl: String, // Stores the Base64 image data
    description: String, // Stores the service description
    createdAt: { type: Date, default: Date.now }
});

const Provider = mongoose.model('Provider', providerSchema);

// 3. Configure Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
    secret: 'mysecretkeyforlocalservice',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// --- BEGIN Flash Message Replacement ---
// Global middleware to handle custom flash messages using session
app.use((req, res, next) => {
    // 1. Transfer flash messages from session to res.locals
    res.locals.success_msg = req.session.success_msg;
    res.locals.error_msg = req.session.error_msg;
    
    // 2. Clear flash messages in session immediately after transfer
    delete req.session.success_msg;
    delete req.session.error_msg;

    res.locals.isLoggedIn = req.session.userId ? true : false;
    
    // 3. Helper function to set flash messages
    req.flash = (type, message) => {
        if (type === 'success') {
            req.session.success_msg = message;
        } else if (type === 'error') {
            req.session.error_msg = message;
        }
    };

    next();
});
// --- END Flash Message Replacement ---

// Middleware to check if the user is authenticated (logged in)
const ensureAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        return next();
    }
    req.flash('error', 'Please log in to view this resource.');
    res.redirect('/login');
};

// 4. Basic Routes

// 4.1 HOME PAGE (GET)
app.get('/', (req, res) => {
    res.render('index', { title: 'Local Service Finder' });
});

// 4.2 REGISTER (GET)
app.get('/register', (req, res) => {
    res.render('register', { title: 'Register' });
});

// 4.3 REGISTER (POST)
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        let provider = await Provider.findOne({ email });
        if (provider) {
            req.flash('error', 'Email already registered.');
            return res.render('register', { title: 'Register', name, email });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        provider = new Provider({
            name,
            email,
            password: hashedPassword,
            category: 'General', // Default category on registration
            contactInfo: '' 
        });

        await provider.save();
        req.flash('success', 'Registration successful. You can now log in.');
        res.redirect('/login');

    } catch (error) {
        console.error('Registration error:', error);
        req.flash('error', 'Server error during registration.');
        res.render('register', { title: 'Register', name, email });
    }
});

// 4.4 LOGIN (GET)
app.get('/login', (req, res) => {
    res.render('login', { title: 'Login' });
});

// 4.5 LOGIN (POST)
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const provider = await Provider.findOne({ email });
        if (!provider) {
            req.flash('error', 'Invalid credentials.');
            return res.render('login', { title: 'Login', email });
        }

        const isMatch = await bcrypt.compare(password, provider.password);
        if (!isMatch) {
            req.flash('error', 'Invalid credentials.');
            return res.render('login', { title: 'Login', email });
        }

        req.session.userId = provider._id;
        req.flash('success', 'Login successful!');
        res.redirect('/provider/profile');

    } catch (error) {
        console.error('Login error:', error);
        req.flash('error', 'Server error during login.');
        res.render('login', { title: 'Login', email });
    }
});

// 4.6 LOGOUT (GET)
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

// 5. Provider Dashboard Routes (Authenticated)

// 5.1 PROVIDER DASHBOARD (GET)
app.get('/provider/profile', ensureAuthenticated, async (req, res) => {
    try {
        const provider = await Provider.findById(req.session.userId);
        if (!provider) {
            req.flash('error', 'Profile not found. Please log in again.');
            return res.redirect('/logout');
        }
        res.render('provider/profile', { 
            title: 'Provider Dashboard', 
            provider: provider 
        });
    } catch (error) {
        console.error('Error fetching provider profile:', error);
        // Destroy session and redirect if the ID is invalid (e.g., Mongoose casting error)
        req.session.destroy(err => {
            if (err) console.error('Error destroying session:', err);
            res.redirect('/login');
        });
    }
});

// 5.5 PROVIDER EDIT PROFILE (GET)
app.get('/provider/edit', ensureAuthenticated, async (req, res) => {
    try {
        const provider = await Provider.findById(req.session.userId);

        if (!provider) {
            req.flash('error', 'Profile not found. Please log in again.');
            return res.redirect('/logout');
        }

        // Fetch unique categories and prepend default/popular ones
        const allCategories = await Provider.distinct('category');
        allCategories.sort();

        res.render('provider/edit-profile', {
            title: 'Edit Profile',
            provider: provider,
            currentCategory: provider.category, // Pass the current category for selection
            uniqueCategories: ['Plumbing', 'Electrician', 'Gardening', 'Cleaning', ...allCategories.filter(c => c && c.trim() !== '')],
            error: null
        });

    } catch (error) {
        console.error('Error rendering edit profile page:', error);
        // This is the critical fix: If Mongoose gets a bad ID or the fetch fails, log out.
        req.session.destroy(err => {
            if (err) console.error('Error destroying session:', err);
            res.redirect('/login');
        });
    }
});


// 5.6 PROVIDER EDIT PROFILE (POST)
app.post('/provider/edit', ensureAuthenticated, async (req, res) => {
    try {
        // Ensure all potential fields are destructured from the request body
        const { contactInfo, category, description, profilePictureData } = req.body;
        const providerId = req.session.userId;
        
        // Build the update object
        const updateFields = { 
            contactInfo, 
            category, 
            description // Ensure description is included
        }; 

        // CRITICAL FIX: Ensure the Base64 image data is handled correctly and saved
        if (profilePictureData && profilePictureData.length > 0) {
            // profilePictureData is the Base64 string from the frontend. We save it directly.
            updateFields.profilePictureUrl = profilePictureData;
        }

        const updatedProvider = await Provider.findByIdAndUpdate(providerId, updateFields, { new: true, runValidators: true });
        
        if (!updatedProvider) {
            req.flash('error', 'Provider profile not found during update.');
            return res.redirect('/provider/edit');
        }
        
        req.flash('success', 'Profile updated successfully!');
        res.redirect('/provider/profile');

    } catch (error) {
        console.error('Error updating provider profile:', error);
        req.flash('error', 'Failed to update profile due to a server error.');
        res.redirect('/provider/edit');
    }
});


// 5.7 PUBLIC PROVIDER PROFILE (GET)
app.get('/provider/view/:id', async (req, res) => {
    try {
        const provider = await Provider.findById(req.params.id);
        if (!provider) {
            req.flash('error', 'Provider not found.');
            return res.redirect('/search');
        }
        res.render('public-profile', {
            title: provider.name + ' - Profile',
            provider: provider,
            isLoggedIn: req.session.userId ? true : false,
        });
    } catch (error) {
        console.error('Error viewing public profile:', error);
        req.flash('error', 'An error occurred fetching the profile.');
        res.redirect('/search');
    }
});


// 5.8 SEARCH SERVICE PROVIDERS (GET)
app.get('/search', async (req, res) => {
    try {
        const query = req.query.query || '';
        const category = req.query.category || 'All Categories'; 
        let filter = {};

        // Build query filter
        if (query) {
            // Case-insensitive search on name
            filter.name = { $regex: query, $options: 'i' };
        }

        if (category && category !== 'All Categories') {
            filter.category = category;
        }

        // Fetch providers matching the filter (This retrieves ALL fields, including profilePictureUrl and description)
        const providers = await Provider.find(filter);

        // Fetch all unique categories for the dropdown
        const uniqueCategories = await Provider.distinct('category');
        uniqueCategories.sort(); 

        res.render('search-results', {
            title: 'Search Results',
            providers: providers,
            query: query,
            selectedCategory: category, // Variable used by EJS template
            uniqueCategories: ['All Categories', 'Plumbing', 'Electrician', 'Gardening', 'Cleaning', ...uniqueCategories.filter(c => c && c.trim() !== '')],
            isLoggedIn: req.session.userId ? true : false,
            error: null
        });

    } catch (error) {
        console.error('Error during search:', error);
        res.render('search-results', {
            title: 'Search Results',
            providers: [],
            query: req.query.query || '',
            selectedCategory: req.query.category || 'All Categories',
            uniqueCategories: ['All Categories', 'Plumbing', 'Electrician', 'Gardening', 'Cleaning'],
            isLoggedIn: req.session.userId ? true : false,
            error: 'An error occurred while searching for providers.'
        });
    }
});


// Start the server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
