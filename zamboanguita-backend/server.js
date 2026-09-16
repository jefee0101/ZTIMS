const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer'); // Added for handling Forgot Password emails
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

/* ==========================================
   1. MIDDLEWARE PIPELINES
========================================== */
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://127.0.0.1:5500,http://localhost:5500')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured before starting the API.');
}

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin is not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 150, standardHeaders: true, legacyHeaders: false }));

// FORCE explicit body-parser rules across ALL incoming payload formats
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: false, parameterLimit: 1000 }));

/* ==========================================
   2. DATABASE CONFIGURATION & CONNECT
========================================== */
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/zamboanguita';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected safely to MongoDB database system.'))
    .catch(err => console.error('❌ MongoDB Connection Error Encountered:', err));

/* ==========================================
   3. DATA SCHEMA & MODELS
========================================== */

// 1. Booking Schema (Linked explicitly via userId)
const BookingSchema = new mongoose.Schema({
    userId: { type: String, required: true }, 
    guestName: { type: String, required: true },
    guestEmail: { type: String, required: true },
    nationality: { type: String, required: true },
    phone: { type: String, required: true }, 
    destination: { type: String, required: true },
    checkInDate: { type: String, required: true },
    checkOutDate: { type: String, required: true },
    guestCount: { type: Number, required: true }, 
    amount: { type: Number, default: 500 }, // Added default amount field for computing live analytical revenue
    status: { type: String, default: 'pending' },   
    // COMPANIONS SUB-ARRAY MAP WITHOUT ALTERING ORIGINAL FIELDS
    companions: [
        {
            name: { type: String, required: true },
            age: { type: Number, required: true }
        }
    ]
}, { timestamps: true });

const Booking = mongoose.model('Booking', BookingSchema);

// 2. Admin Authentication Schema
const AdminSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false }
}, { collection: 'admins' }); 

const Admin = mongoose.model('Admin', AdminSchema);

// 3. User/Traveler Authentication Schema (🌟 UPGRADED TO ACCEPT AUTOFILL PROPERTIES)
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    fullName: { type: String, default: "" },      
    phone: { type: String, default: "" },         
    nationality: { type: String, default: "" }    
}, { collection: 'users', timestamps: true }); 

const User = mongoose.model('User', UserSchema);

// 4. 🌟 UPDATED: Review Schema perfectly paired with frontend assets & text fields
const ReviewSchema = new mongoose.Schema({
    guestName: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    destinationId: { type: String, required: true }, // Holds selected location text
    comment: { type: String, required: true },
    imageURL: { type: String, required: false }, // Stores uploaded Base64 image snapshot strings
    status: { type: String, default: 'approved' } // 🌟 Support status transitions for moderation
}, { timestamps: true });

const Review = mongoose.model('Review', ReviewSchema);

// 5. Minimalistic Spot Schema to fix visual layout parser errors 
const SpotSchema = new mongoose.Schema({
    title: { type: String, required: true },
    location: { type: String, required: true },
    category: { type: String, required: true },
    description: { type: String, required: true },
    imageUrl: { type: String }
}, { timestamps: true });

const Spot = mongoose.model('Spot', SpotSchema);

const requireAuth = (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required.' });

    try {
        req.auth = jwt.verify(token, process.env.JWT_SECRET);
        return next();
    } catch {
        return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
    }
};

const requireAdmin = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'admin') return res.status(403).json({ success: false, message: 'Administrator access required.' });
    return next();
}];

const createToken = (account, role) => jwt.sign(
    { sub: account._id.toString(), role },
    process.env.JWT_SECRET,
    { expiresIn: '2h', issuer: 'ztims-api', audience: 'ztims-web' }
);


/* ==========================================
   4. API ROUTE HANDLERS
========================================== */

/**
 * 🌟 POST: Add and register a brand new Admin into MongoDB
 * Target URL: http://localhost:5000/api/admin/create
 */
app.post('/api/admin/create', requireAdmin, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Missing mandatory email or password parameters.' });
        }

        const normalizedEmail = email.toLowerCase().trim();

        // Check if an admin with this email already exists
        const existingAdmin = await Admin.findOne({ email: normalizedEmail });
        if (existingAdmin) {
            return res.status(409).json({ success: false, message: 'This email is already registered as an admin.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const newAdmin = new Admin({ 
            email: normalizedEmail, 
            password: passwordHash
        });
        
        await newAdmin.save();

        console.log(`🛡️ New Administrator saved directly to MongoDB 'admins' collection: ${normalizedEmail}`);
        return res.status(201).json({ success: true, message: 'New admin successfully added!' });
    } catch (error) {
        console.error("❌ Add Admin Endpoint Failure:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * 🌟 GET: Fetch list of all system administrators from MongoDB
 * Target URL: http://localhost:5000/api/admin/list
 */
app.get('/api/admin/list', requireAdmin, async (req, res) => {
    try {
        const adminList = await Admin.find({}, { password: 0 });
        return res.status(200).json(adminList);
    } catch (error) {
        console.error("❌ Get Admin List Endpoint Failure:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * POST: Register new traveler accounts into MongoDB (🌟 UPGRADED TO CAPTURE INPUT VALUES)
 * Target URL: http://localhost:5000/api/register
 */
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, fullName, phone, nationality } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Missing mandatory email or password keys.' });
        }

        const normalizedEmail = email.toLowerCase().trim();

        // Prevent duplicate account registrations
        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'This email account is already registered.' });
        }

        // Create user with extended parameters map
        const passwordHash = await bcrypt.hash(password, 12);
        const newUser = new User({ 
            email: normalizedEmail, 
            password: passwordHash,
            fullName: fullName || "",
            phone: phone || "",
            nationality: nationality || ""
        });
        await newUser.save();

        console.log(`👤 New user saved directly to MongoDB collection with profile properties: ${normalizedEmail}`);
        return res.status(201).json({ success: true, message: 'Registration complete!' });
    } catch (error) {
        console.error("❌ Registration Endpoint Failure:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * POST: Dynamic Authentication for both Admin and User Portals (🌟 UPGRADED TO RETURN USER PROFILE DETAILS)
 * Target URL: http://localhost:5000/api/login
 */
app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
    try {
        const { email, password, role } = req.body; 
        console.log(`➡️ Login attempt received for: ${email} | Role Context: ${role || 'user'}`);

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Missing email or password.' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        let account = null;

        if (role === 'admin') {
            account = await Admin.findOne({ email: normalizedEmail }).select('+password');
        } else {
            account = await User.findOne({ email: normalizedEmail }).select('+password');
        }

        if (!account || !(await bcrypt.compare(password, account.password))) {
            return res.status(401).json({ 
                success: false, 
                message: `Authentication failed: Invalid ${role === 'admin' ? 'Admin' : 'User'} Credentials.` 
                });
        }

        // Base payload data structures object mapping logic
        const responseData = {
            success: true,
            message: `Login Successful! Welcome back.`,
            token: createToken(account, role === 'admin' ? 'admin' : 'user'),
            role: role === 'admin' ? 'admin' : 'user',
            userId: account._id, // Sends valid object database identifier instead of 'anonymous_guest'
            user: {
                email: account.email,
                name: account.fullName || account.email.split('@')[0],
                fullName: account.fullName || "",
                phone: account.phone || "",
                nationality: account.nationality || ""
            }
        };

        return res.status(200).json(responseData);
    } catch (error) {
        console.error("❌ Auth Route Error:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// Configure Nodemailer for Email Transports
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'your-tourism-email@gmail.com', // Change to your project email account
    pass: 'your-app-password'             // App Password generated via Google Account Security settings
  }
});

/**
 * 🌟 NEW HANDLER - POST: Handle Forgot Password Email Despatches
 * Target URL: http://localhost:5000/api/forgot-password
 */
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: "Email required." });

        const normalizedEmail = email.toLowerCase().trim();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            return res.status(404).json({ success: false, message: "No user account found with that email." });
        }

        // Pointing to Live Server environments folder trees
        const resetLink = `http://127.0.0.1:5500/src/user/reset_password.html?email=${encodeURIComponent(normalizedEmail)}`;

        const mailOptions = {
            from: '"Zamboanguita Tourism" <your-tourism-email@gmail.com>',
            to: normalizedEmail,
            subject: 'Reset Password Request - Zamboanguita Tourism',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #2E7D32;">Zamboanguita Tourism Portal</h2>
                    <p>Hello,</p>
                    <p>We received a request to change the password for your account.</p>
                    <p>Click the link below to securely create a new password:</p>
                    <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; color: white; background-color: #2E7D32; text-decoration: none; border-radius: 25px; font-weight: bold; margin: 15px 0;">Reset Password</a>
                    <p>If you didn't ask to change your password, you can safely ignore this email.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        return res.status(200).json({ success: true, message: "Reset link emailed successfully." });

    } catch (error) {
        console.error("Forgot password error:", error);
        return res.status(500).json({ success: false, message: "Server error sending email link." });
    }
});

/**
 * 🌟 NEW HANDLER - POST: Commit Password Reset changes safely to Database
 * Target URL: http://localhost:5000/api/reset-password
 */
app.post('/api/reset-password', async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        if (!email || !newPassword) return res.status(400).json({ success: false, message: "Missing data payload." });

        const updatedUser = await User.findOneAndUpdate(
            { email: email.toLowerCase().trim() },
            { $set: { password: newPassword } },
            { new: true }
        );

        if (!updatedUser) return res.status(404).json({ success: false, message: "User profile record not found." });

        return res.status(200).json({ success: true, message: "Password updated completely!" });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Internal server update error." });
    }
});

/**
 * POST: Create and insert new booking document record
 */
app.post('/api/bookings', async (req, res) => {
    try {
        console.log("➡️ Received Incoming Booking Payload Data:", req.body);
        
        const { userId, guestName, destination, guestCount } = req.body;
        if (!userId || !guestName || !destination || !guestCount) {
            return res.status(400).json({ 
                error: 'Bad Request', 
                message: 'Validation failed: Missing mandatory parameter keys.' 
            });
        }

        const newBooking = new Booking(req.body);
        const savedRecord = await newBooking.save();
        
        console.log("🚀 Booking Record Committed Successfully:", savedRecord._id);
        return res.status(201).json({ 
            message: 'Success', 
            bookingId: savedRecord._id 
        });

    } catch (error) {
        console.error("❌ Database Write Failure Details:", error);
        return res.status(500).json({ 
            error: 'Server Error: Failed to commit record entry.', 
            message: error.message 
        });
    }
});

/**
 * GET: Retrieve booking list (Optional ?userId filter)
 */
app.get('/api/bookings', async (req, res) => {
    try {
        const { userId } = req.query;
        
        let query = {};
        if (userId) {
            query = { userId };
        }

        const records = await Booking.find(query).sort({ createdAt: -1 });
        return res.json(records);

    } catch (error) {
        console.error("❌ Database Query Error:", error);
        return res.status(500).json({ 
            error: 'Failed to download user booking manifestation matrix.',
            message: error.message 
        });
    }
});

/**
 * PUT: user cancel or update booking status (e.g., 'cancelled') in MongoDB
 */
app.patch('/api/bookings/:id', async (req, res) => {
    try {
        const { status } = req.body; // e.g., 'cancelled'
        const updatedBooking = await Booking.findByIdAndUpdate(
            req.params.id, 
            { status: status }, 
            { new: true }
        );
        res.status(200).json(updatedBooking);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT: Admin route to approve or reject a booking status inside MongoDB
 */
app.put('/api/bookings/status/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body; 

        if (!['approved', 'disapproved'].includes(status)) {
            return res.status(400).json({ message: 'Invalid target status type parameter.' });
        }

        const updatedBooking = await Booking.findByIdAndUpdate(
            id,
            { status: status },
            { new: true }
        );

        if (!updatedBooking) {
            return res.status(404).json({ message: 'Booking reference entry not found.' });
        }

        console.log(`📢 Booking ${id} status state updated to: ${status.toUpperCase()}`);
        return res.status(200).json({ success: true, data: updatedBooking });
    } catch (error) {
        console.error("❌ Admin Status PUT Failure:", error);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

/**
 * 🌟 GET: Fetch all user reviews from MongoDB
 * Target URL: http://localhost:5000/api/reviews
 */
app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Review.find({}).sort({ createdAt: -1 });
        return res.status(200).json(reviews);
    } catch (error) {
        console.error("❌ Review GET Fetch Failure:", error);
        return res.status(500).json({ error: 'Failed to fetch reviews matrix.', message: error.message });
    }
});

/**
 * 🌟 POST: Submit a new review into MongoDB 
 * Target URL: http://localhost:5000/api/reviews
 */
app.post('/api/reviews', async (req, res) => {
    try {
        console.log("➡️ Received Incoming Review Payload Data:", req.body);
        const { guestName, rating, destinationId, comment, imageURL } = req.body;
        
        // Exact validation criteria aligning with frontend payload structures
        if (!guestName || !rating || !destinationId || !comment) {
            return res.status(400).json({ message: 'Validation failed: Missing mandatory review payload keys.' });
        }

        const newReview = new Review({
            guestName,
            rating: Number(rating),
            destinationId,
            comment,
            imageURL: imageURL || "",
            status: 'approved' // Automatically default to approved state on submission
        });
        
        const savedReview = await newReview.save();
        
        console.log(`💬 New review committed safely from user: ${guestName} for location: ${destinationId}`);
        return res.status(201).json(savedReview);
    } catch (error) {
        console.error("❌ Review POST Submission Failure:", error);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

/**
 * 🌟 NEW HANDLER - PUT: Update review status filters (Approve/Hide)
 * Target URL: http://localhost:5000/api/reviews/:id/status
 */
app.put('/api/reviews/:id/status', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['approved', 'pending', 'hidden', 'reported'].includes(status)) {
            return res.status(400).json({ message: 'Invalid target status property.' });
        }

        const updatedReview = await Review.findByIdAndUpdate(
            id,
            { status: status },
            { new: true }
        );

        if (!updatedReview) {
            return res.status(404).json({ message: 'Review documentation tracker not found.' });
        }

        console.log(`🛡️ Review state toggled manually: ${id} changed to ${status}`);
        return res.status(200).json(updatedReview);
    } catch (error) {
        console.error("❌ Review Status PUT Failure:", error);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

/**
 * 🌟 NEW HANDLER - DELETE: Drop review entry records entirely from database
 * Target URL: http://localhost:5000/api/reviews/:id
 */
app.delete('/api/reviews/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const droppedRecord = await Review.findByIdAndDelete(id);

        if (!droppedRecord) {
            return res.status(404).json({ success: false, message: 'Review item identifier not found.' });
        }

        console.log(`🗑️ Review dropped from database completely: ${id}`);
        return res.status(200).json({ success: true, message: 'Review successfully deleted.' });
    } catch (error) {
        console.error("❌ Review Deletion System Interrupt:", error);
        return res.status(500).json({ success: false, error: 'Internal Server Error', message: error.message });
    }
});

/**
 * 🌟 NEW HANDLER - PATCH: Update a user's structural profile fields directly from booking form submissions
 * Target URL: http://localhost:5000/api/users/:id
 */
app.patch('/api/users/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        const { fullName, phone, nationality } = req.body;

        // Find user by route identifier and update fields dynamically
        const updatedUser = await User.findByIdAndUpdate(
            userId,
            { 
                $set: { 
                    fullName: fullName,
                    phone: phone,
                    nationality: nationality 
                } 
            },
            { new: true, runValidators: true }
        );

        if (!updatedUser) {
            return res.status(404).json({ error: "User account document location not found." });
        }

        console.log(`👤 Profile updated for user ID: ${userId} [Name: ${fullName}, Phone: ${phone}, Nationality: ${nationality}]`);
        return res.status(200).json({ message: "User profile synchronized successfully.", user: updatedUser });
    } catch (err) {
        console.error("❌ Failed to run profile document amendment:", err);
        return res.status(500).json({ error: "Internal server update pipeline failure.", message: err.message });
    }
});

/* ==========================================
   ADDED: LIVE ANALYTICS MAPPER LINKS
========================================== */

/**
 * 🌟 GET: Fetch all active users for analytics tracking
 * Target URL: http://localhost:5000/api/users
 */
app.get('/api/users', async (req, res) => {
    try {
        const usersList = await User.find({}, { password: 0 });
        return res.status(200).json(usersList);
    } catch (error) {
        return res.status(500).json([]);
    }
});

/**
 * 🌟 GET & POST: Destination system endpoints to prevent dashboard client parsing error loops
 * Target URL: http://localhost:5000/api/spots
 */
app.get('/api/spots', async (req, res) => {
    try {
        const activeSpots = await Spot.find({}).sort({ createdAt: -1 });
        return res.status(200).json(activeSpots);
    } catch (error) {
        return res.status(500).json([]);
    }
});

app.post('/api/spots', requireAdmin, async (req, res) => {
    try {
        const newSpot = new Spot(req.body);
        const savedSpot = await newSpot.save();
        return res.status(201).json(savedSpot);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/* ==========================================
   5. DEPLOYMENT PORT INITIALIZER
========================================== */
const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(` 🚀 Server actively streaming data loops at:`);
    console.log(`     👉 http://localhost:${PORT}`);
    console.log(`=================================================`);
});
