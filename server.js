// server.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const session = require('express-session');
const path = require('path');
const User = require('./models/User'); // Mongoose Model

// Load environment variables (from .env locally, from Render remotely)
dotenv.config();

// === 1. INITIALIZE APP & PORT ===
const app = express(); 
const PORT = process.env.PORT || 3000; 

// === 2. DATABASE CONNECTION (Using the environment variable) ===
mongoose.connect(process.env.DATABASE_URL)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('DB Connection Error:', err));

// === 3. MIDDLEWARE & VIEW ENGINE SETUP ===
app.set('view engine', 'ejs'); 
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files (CSS/JS/Images)

// Body Parsers & Session Setup
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' } 
}));

// === 4. AUTH MIDDLEWARE (Conceptual) === 
function isLoggedIn(req, res, next) {
    if (req.session.userId) {
        // In a real app, you would fetch the user here: req.user = User.findById(req.session.userId);
        return next();
    }
    res.redirect('/login');
}

// === 5. ROUTES (Minimum Required) ===
app.get('/', (req, res) => {
    res.render('index'); // Landing page with search form
});

// Search Route (Implementation required)
app.get('/search', (req, res) => {
    // You will add database query logic here
    res.render('search-results', { providers: [] });
});

app.get('/login', (req, res) => { res.render('login'); });
app.post('/login', (req, res) => { /* Authentication logic here */ res.redirect('/provider/profile'); });
app.get('/subscribe', isLoggedIn, (req, res) => { res.render('subscribe'); }); // Payment gateway view

app.get('/provider/profile', isLoggedIn, (req, res) => {
    res.send('Welcome to your secure profile page.');
});

// === 6. START THE SERVER ===
app.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});