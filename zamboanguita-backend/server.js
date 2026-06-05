import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import connectDB from './db.js';
import Booking from './Booking.js'; // Ensure this file exists in the same folder

// Load environment variables
dotenv.config();

// 1. Initialize Express App
const app = express();

// 2. Connect to MongoDB (Using your separate db.js logic)
connectDB();

// 3. Middlewares
app.use(cors());
app.use(express.json()); // Built-in alternative to body-parser

// 4. Define User Schema & Model (Kept inline as it was in your snippet)
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: "user" } // 'admin' or 'user'
});

const User = mongoose.model('User', userSchema);

// --- ROUTES ---

// Route A: Create a Booking
app.post('/api/bookings', async (req, res) => {
    try {
        const { 
            guestName, guestEmail, nationality, phone, 
            destination, checkInDate, checkOutDate, guestCount 
        } = req.body;
        
        const newBooking = new Booking({ 
            guestName, guestEmail, nationality, phone, 
            destination, checkInDate, checkOutDate, guestCount 
        });

        await newBooking.save(); 
        res.status(201).json({ message: 'Booking entry logged securely!', data: newBooking });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Route B: Get all Bookings (Optional)
app.get('/api/bookings', async (req, res) => {
    try {
        const bookings = await Booking.find();
        res.status(200).json(bookings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Route C: Login API Route
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Find user by email
        const user = await User.findOne({ email });
        
        if (!user) {
            return res.status(400).json({ success: false, message: "User not found." });
        }

        // Check password (⚠️ In production, use bcrypt!)
        if (user.password !== password) {
            return res.status(400).json({ success: false, message: "Incorrect password." });
        }

        // Check if user is an admin
        if (user.role !== 'admin') {
            return res.status(403).json({ success: false, message: "Access denied. Not an admin." });
        }

        // Success
        res.json({ success: true, message: "Welcome Admin!", redirectUrl: "admin_analystic.html" });

    } catch (error) {
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// 5. Start Server Listening
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running beautifully on http://localhost:${PORT}`);
});