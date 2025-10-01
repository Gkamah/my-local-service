// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // Hashed password
    role: { type: String, enum: ['seeker', 'provider'], default: 'provider' },
    
    // Provider Profile Fields
    name: String,
    category: { type: String, required: true },
    contactInfo: { type: String, required: true },
    profilePicture: String, 
    sampleWork: [String], 
    
    // Subscription & Trial Logic
    isSubscribed: { type: Boolean, default: false },
    trialStartDate: { type: Date, default: Date.now },
    subscriptionExpires: Date, 
    mpesaTransactions: [String], 
});

module.exports = mongoose.model('User', userSchema);