const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer'); // Added for handling Forgot Password emails
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

// Verifies Google ID tokens against Google's own public keys.
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const app = express();

/* ==========================================
   1. MIDDLEWARE PIPELINES
========================================== */
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://127.0.0.1:5500,http://localhost:5500')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

// Vercel gives every branch and every redeploy its own preview hostname, so the
// production origin alone would break previews on each push.
const previewOriginPattern = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

const isAllowedOrigin = (origin) => allowedOrigins.includes(origin) || previewOriginPattern.test(origin);

if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured before starting the API.');
}

// Render terminates TLS at its edge proxy. Without this, every request looks like
// it comes from that one proxy IP and the rate limiters below bucket the entire
// internet together — 10 shared login attempts per 15 minutes for all visitors.
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
    origin(origin, callback) {
        // No Origin header means a non-browser client (curl, Postman, health checks).
        if (!origin || isAllowedOrigin(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS`));
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

// 2. Admin Authentication Schema
const AdminSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false }
}, { collection: 'admins' }); 

const Admin = mongoose.model('Admin', AdminSchema);

// 3. User/Traveler Authentication Schema (🌟 UPGRADED TO ACCEPT AUTOFILL PROPERTIES)
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Google accounts have no password of their own, so this is only required for
    // accounts that actually sign in with one.
    password: {
        type: String,
        required: function () { return this.provider !== 'google'; },
        select: false
    },
    provider: { type: String, enum: ['local', 'google'], default: 'local' },
    // sparse: only documents that actually have a googleId take part in the unique
    // index, so the many password-only users don't collide on null.
    googleId: { type: String, default: null, unique: true, sparse: true },
    avatar: { type: String, default: "" },
    fullName: { type: String, default: "" },
    phone: { type: String, default: "" },
    nationality: { type: String, default: "" }
}, { collection: 'users', timestamps: true });

const User = mongoose.model('User', UserSchema);

// 3b. Resort Owner Authentication Schema (manages their own tourist spots/accommodations only)
const ResortOwnerSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    resortName: { type: String, required: true, trim: true },
    phone: { type: String, default: "" }
}, { collection: 'resortOwners', timestamps: true });

const ResortOwner = mongoose.model('ResortOwner', ResortOwnerSchema);

// 4. 🌟 UPDATED: Review Schema perfectly paired with frontend assets & text fields
const ReviewSchema = new mongoose.Schema({
    guestName: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    destinationId: { type: String, required: true }, // Holds selected location text
    // Reviews were originally matched to a spot by its name alone, which breaks as
    // soon as a spot is renamed. New reviews carry the real reference; the older
    // name-only ones still resolve through destinationId.
    spotId: { type: mongoose.Schema.Types.ObjectId, ref: 'Spot', default: null },
    comment: { type: String, required: true },
    imageURL: { type: String, required: false }, // Stores uploaded Base64 image snapshot strings
    status: { type: String, default: 'approved' } // 🌟 Support status transitions for moderation
}, { timestamps: true });

const Review = mongoose.model('Review', ReviewSchema);

// 5. Spot Schema — covers both tourist spots and resort accommodations, owned either
//    by the Tourist Officer (municipal-level, no owner) or by a Resort Owner account.
const SpotSchema = new mongoose.Schema({
    title: { type: String, required: true },
    location: { type: String, required: true },
    category: { type: String, required: true },
    description: { type: String, required: true },
    imageUrl: { type: String },
    // Booking happens on the resort's own website — this is where "Book Now" sends
    // the visitor. Blank means the detail page shows contact details instead.
    bookingUrl: { type: String, default: "" },
    type: { type: String, enum: ['spot', 'accommodation'], default: 'spot' },
    label: { type: String, default: "" },
    workingDays: { type: String, default: "Everyday" },
    workingTime: { type: String, default: "All Day" },
    travelFee: { type: Number, default: 0 },
    entranceFee: { type: Number, default: 0 },
    // Null/absent = managed directly by the Tourist Officer. Set = owned by a Resort Owner.
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ResortOwner', default: null }
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
    if (req.auth.role !== 'admin') return res.status(403).json({ success: false, message: 'Tourist Officer access required.' });
    return next();
}];

const requireResortOwner = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'resort_owner') return res.status(403).json({ success: false, message: 'Resort Owner access required.' });
    return next();
}];

// Reviewing is a visitor's act. Without this, a resort owner could post glowing
// reviews of their own listing, which is the one thing the ratings must not allow.
const requireTourist = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'user') {
        return res.status(403).json({ success: false, message: 'Only tourist accounts can do this.' });
    }
    return next();
}];

// Tourist Officer or Resort Owner — used on routes both manage, each scoped to their own data.
const requireStaff = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'admin' && req.auth.role !== 'resort_owner') {
        return res.status(403).json({ success: false, message: 'Staff access required.' });
    }
    return next();
}];

const optionalAuth = (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (token) {
        try { req.auth = jwt.verify(token, process.env.JWT_SECRET); } catch { /* Public access remains available. */ }
    }
    return next();
};

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
 * POST: Tourist Officer creates a Resort Owner account (owners do not self-register —
 * the Tourist Officer oversees the whole system and issues these accounts directly)
 * Target URL: http://localhost:5000/api/resort-owners
 */
app.post('/api/resort-owners', requireAdmin, async (req, res) => {
    try {
        const { email, password, resortName, phone } = req.body;

        if (!email || !password || !resortName) {
            return res.status(400).json({ success: false, message: 'Missing mandatory email, password, or resort name.' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const existingOwner = await ResortOwner.findOne({ email: normalizedEmail });
        if (existingOwner) {
            return res.status(409).json({ success: false, message: 'This email is already registered as a resort owner.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const newOwner = new ResortOwner({
            email: normalizedEmail,
            password: passwordHash,
            resortName: resortName.trim(),
            phone: phone || ""
        });
        await newOwner.save();

        console.log(`🏨 New Resort Owner account created by Tourist Officer: ${normalizedEmail}`);
        return res.status(201).json({ success: true, message: 'Resort owner account created!' });
    } catch (error) {
        console.error("❌ Create Resort Owner Endpoint Failure:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * GET: Tourist Officer lists all resort owner accounts
 * Target URL: http://localhost:5000/api/resort-owners
 */
app.get('/api/resort-owners', requireAdmin, async (req, res) => {
    try {
        const owners = await ResortOwner.find({}, { password: 0 });
        return res.status(200).json(owners);
    } catch (error) {
        console.error("❌ Get Resort Owner List Endpoint Failure:", error);
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
        // 'staff' means the caller doesn't know which kind of staff account this is
        // — the shared staff sign-in page. We work it out rather than making the
        // person choose, since picking the wrong portal would reject a correct password.
        const requestedRole = ['admin', 'resort_owner', 'staff'].includes(role) ? role : 'user';
        let account = null;
        let resolvedRole = requestedRole;

        if (requestedRole === 'staff') {
            account = await Admin.findOne({ email: normalizedEmail }).select('+password');
            resolvedRole = 'admin';

            if (!account) {
                account = await ResortOwner.findOne({ email: normalizedEmail }).select('+password');
                resolvedRole = 'resort_owner';
            }
        } else if (requestedRole === 'admin') {
            account = await Admin.findOne({ email: normalizedEmail }).select('+password');
        } else if (requestedRole === 'resort_owner') {
            account = await ResortOwner.findOne({ email: normalizedEmail }).select('+password');
        } else {
            account = await User.findOne({ email: normalizedEmail }).select('+password');
        }

        if (!account || !(await bcrypt.compare(password, account.password))) {
            // Deliberately the same wording whichever collection was searched, so the
            // response can't be used to discover which emails are registered.
            const audience = requestedRole === 'staff' ? 'staff' : resolvedRole === 'admin' ? 'Tourist Officer' : resolvedRole === 'resort_owner' ? 'Resort Owner' : 'User';
            return res.status(401).json({
                success: false,
                message: `Authentication failed: Invalid ${audience} credentials.`
                });
        }

        // Base payload data structures object mapping logic
        const responseData = {
            success: true,
            message: `Login Successful! Welcome back.`,
            token: createToken(account, resolvedRole),
            role: resolvedRole,
            userId: account._id, // Sends valid object database identifier instead of 'anonymous_guest'
            user: {
                email: account.email,
                name: account.fullName || account.resortName || account.email.split('@')[0],
                fullName: account.fullName || "",
                phone: account.phone || "",
                nationality: account.nationality || "",
                resortName: account.resortName || ""
            }
        };

        return res.status(200).json(responseData);
    } catch (error) {
        console.error("❌ Auth Route Error:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * 🌟 POST: Sign in (or register) a tourist with a Google account
 * The browser gets an ID token from Google and sends it here; this verifies that
 * token with Google directly, so a forged one can't get through.
 * Target URL: http://localhost:5000/api/auth/google
 */
app.post('/api/auth/google', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
    try {
        if (!process.env.GOOGLE_CLIENT_ID) {
            return res.status(503).json({ success: false, message: 'Google sign-in is not configured on the server yet.' });
        }

        const { credential } = req.body;
        if (!credential) {
            return res.status(400).json({ success: false, message: 'Missing Google credential.' });
        }

        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();

        if (!payload?.email_verified) {
            return res.status(401).json({ success: false, message: 'This Google account has no verified email address.' });
        }

        const email = payload.email.toLowerCase().trim();

        // Someone who already registered with a password keeps that one account —
        // signing in with the same Google email links the two rather than creating
        // a second account they'd never be able to find.
        let account = await User.findOne({ email });

        if (account) {
            if (!account.googleId) {
                account.googleId = payload.sub;
                account.avatar = account.avatar || payload.picture || "";
                if (!account.fullName) account.fullName = payload.name || "";
                await account.save();
            }
        } else {
            account = await new User({
                email,
                provider: 'google',
                googleId: payload.sub,
                avatar: payload.picture || "",
                fullName: payload.name || ""
            }).save();
        }

        console.log(`🔐 Google sign-in for ${email}`);
        return res.status(200).json({
            success: true,
            message: 'Signed in with Google.',
            token: createToken(account, 'user'),
            role: 'user',
            userId: account._id,
            user: {
                email: account.email,
                name: account.fullName || account.email.split('@')[0],
                fullName: account.fullName || "",
                phone: account.phone || "",
                nationality: account.nationality || "",
                avatar: account.avatar || ""
            }
        });
    } catch (error) {
        console.error("❌ Google Sign-In Failure:", error);
        return res.status(401).json({ success: false, message: 'Could not verify that Google account. Please try again.' });
    }
});

// Configure Nodemailer for Email Transports. Credentials come from the environment
// — the address and Gmail App Password must never be committed.
const mailConfigured = Boolean(process.env.MAIL_USER && process.env.MAIL_PASSWORD);

const transporter = mailConfigured
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASSWORD }
    })
    : null;

if (!mailConfigured) {
    console.warn('⚠️  MAIL_USER / MAIL_PASSWORD are not set — password reset emails are disabled.');
}

/**
 * 🌟 NEW HANDLER - POST: Handle Forgot Password Email Despatches
 * Target URL: http://localhost:5000/api/forgot-password
 */
app.post('/api/forgot-password', async (req, res) => {
    try {
        // Say so plainly rather than appearing to send an email that never arrives.
        if (!mailConfigured) {
            return res.status(503).json({
                success: false,
                message: "Password reset email isn't set up yet. Please contact the tourism office to have your password reset."
            });
        }

        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: "Email required." });

        const normalizedEmail = email.toLowerCase().trim();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            return res.status(404).json({ success: false, message: "No user account found with that email." });
        }

        // Pointing to Live Server environments folder trees
        // Must point at the deployed site, not a local dev server, or the link in
        // the email is useless to everyone but the developer.
        const siteUrl = (process.env.PUBLIC_SITE_URL || allowedOrigins[0] || '').replace(/\/$/, '');
        const resetLink = `${siteUrl}/src/user/reset_password.html?email=${encodeURIComponent(normalizedEmail)}`;

        const mailOptions = {
            from: `"Zamboanguita Tourism" <${process.env.MAIL_USER}>`,
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

        const passwordHash = await bcrypt.hash(newPassword, 12);
        const updatedUser = await User.findOneAndUpdate(
            { email: email.toLowerCase().trim() },
            { $set: { password: passwordHash } },
            { new: true }
        );

        if (!updatedUser) return res.status(404).json({ success: false, message: "User profile record not found." });

        return res.status(200).json({ success: true, message: "Password updated completely!" });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Internal server update error." });
    }
});

/**
 * 🌟 GET: Fetch all user reviews from MongoDB
 * Target URL: http://localhost:5000/api/reviews
 */
app.get('/api/reviews', optionalAuth, async (req, res) => {
    try {
        const query = req.auth?.role === 'admin' ? {} : { status: 'approved' };
        const reviews = await Review.find(query).sort({ createdAt: -1 });
        return res.status(200).json(reviews);
    } catch (error) {
        console.error("❌ Review GET Fetch Failure:", error);
        return res.status(500).json({ error: 'Failed to fetch reviews matrix.', message: error.message });
    }
});

/**
 * 🌟 GET: Approved reviews for one spot, for its public detail page.
 * Matches on the spot reference and on the spot's name, so reviews written before
 * reviews carried a reference still show up.
 * Target URL: http://localhost:5000/api/spots/:id/reviews
 */
app.get('/api/spots/:id/reviews', async (req, res) => {
    try {
        const spot = await Spot.findById(req.params.id);
        if (!spot) return res.status(404).json({ message: 'Spot not found.' });

        const reviews = await Review.find({
            status: 'approved',
            $or: [{ spotId: spot._id }, { destinationId: spot.title }]
        }).sort({ createdAt: -1 });

        const averageRating = reviews.length
            ? Number((reviews.reduce((sum, review) => sum + (review.rating || 0), 0) / reviews.length).toFixed(1))
            : null;

        return res.status(200).json({ reviews, averageRating, total: reviews.length });
    } catch (error) {
        console.error("❌ Spot Reviews Fetch Failure:", error);
        return res.status(500).json({ reviews: [], averageRating: null, total: 0 });
    }
});

/**
 * 🌟 POST: Submit a new review into MongoDB 
 * Target URL: http://localhost:5000/api/reviews
 */
app.post('/api/reviews', requireTourist, async (req, res) => {
    try {
        console.log("➡️ Received Incoming Review Payload Data:", req.body);
        const { guestName, rating, destinationId, comment, imageURL, spotId } = req.body;

        // Exact validation criteria aligning with frontend payload structures
        if (!guestName || !rating || !destinationId || !comment) {
            return res.status(400).json({ message: 'Validation failed: Missing mandatory review payload keys.' });
        }

        const newReview = new Review({
            guestName,
            rating: Number(rating),
            destinationId,
            spotId: spotId || null,
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
app.patch('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.params.id;
        // This edits the tourist directory, so only a tourist editing themselves or
        // the Tourist Officer may touch it. A resort owner was already refused by
        // the ownership check below, but only as a side effect of their id never
        // matching a tourist's — saying so explicitly keeps that intentional.
        if (req.auth.role !== 'admin' && req.auth.role !== 'user') {
            return res.status(403).json({ error: 'Only tourist accounts have a profile here.' });
        }
        if (req.auth.role !== 'admin' && req.auth.sub !== userId) {
            return res.status(403).json({ error: 'You may only update your own profile.' });
        }
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
app.get('/api/users', requireAdmin, async (req, res) => {
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
 *
 * GET stays public — guests browse tourist spots/accommodations without logging in.
 * Pass ?mine=true (Resort Owner) to scope results to the caller's own listings.
 */
app.get('/api/spots', optionalAuth, async (req, res) => {
    try {
        const query = {};
        if (req.query.mine === 'true' && req.auth?.role === 'resort_owner') {
            query.ownerId = req.auth.sub;
        }
        const activeSpots = await Spot.find(query).sort({ createdAt: -1 });
        return res.status(200).json(activeSpots);
    } catch (error) {
        return res.status(500).json([]);
    }
});

app.post('/api/spots', requireStaff, async (req, res) => {
    try {
        const ownerId = req.auth.role === 'resort_owner' ? req.auth.sub : (req.body.ownerId || null);
        const newSpot = new Spot({ ...req.body, ownerId });
        const savedSpot = await newSpot.save();
        return res.status(201).json(savedSpot);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * GET: Fetch a single spot by id (public — used to pre-fill a booking from the landing page)
 * Target URL: http://localhost:5000/api/spots/:id
 */
app.get('/api/spots/:id', async (req, res) => {
    try {
        // Only the owner's public-facing contact details — never their email or
        // password hash, since this route is open to anyone.
        const spot = await Spot.findById(req.params.id).populate('ownerId', 'resortName phone');
        if (!spot) return res.status(404).json({ message: 'Spot not found.' });
        return res.status(200).json(spot);
    } catch (error) {
        return res.status(404).json({ message: 'Spot not found.' });
    }
});

/**
 * PUT/DELETE: Resort Owners manage only their own spot; the Tourist Officer manages any.
 * Target URL: http://localhost:5000/api/spots/:id
 */
app.put('/api/spots/:id', requireStaff, async (req, res) => {
    try {
        const spot = await Spot.findById(req.params.id);
        if (!spot) return res.status(404).json({ message: 'Spot not found.' });
        if (req.auth.role === 'resort_owner' && String(spot.ownerId) !== req.auth.sub) {
            return res.status(403).json({ message: 'You may only edit your own listing.' });
        }

        const { ownerId, ...updates } = req.body; // ownership cannot be reassigned from this route
        Object.assign(spot, updates);
        const savedSpot = await spot.save();
        return res.status(200).json(savedSpot);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.delete('/api/spots/:id', requireStaff, async (req, res) => {
    try {
        const spot = await Spot.findById(req.params.id);
        if (!spot) return res.status(404).json({ message: 'Spot not found.' });
        if (req.auth.role === 'resort_owner' && String(spot.ownerId) !== req.auth.sub) {
            return res.status(403).json({ message: 'You may only delete your own listing.' });
        }

        await spot.deleteOne();
        return res.status(200).json({ success: true, message: 'Spot deleted.' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/* ==========================================
   5. ERROR HANDLER
========================================== */

/**
 * Without this, a rejected CORS origin falls through to Express's default handler,
 * which answers with an HTML 500 carrying no CORS headers — so the browser reports
 * a confusing "no Access-Control-Allow-Origin" error instead of the real reason,
 * and the frontend's response.json() throws on the HTML body.
 */
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    const isCorsRejection = err && typeof err.message === 'string' && err.message.includes('not allowed by CORS');
    if (isCorsRejection) {
        console.warn(`🚫 Blocked request from disallowed origin: ${req.get('origin')}`);
        return res.status(403).json({
            success: false,
            message: `This site's address is not on the API's allowed list. Add it to the CORS_ORIGIN environment variable.`,
            origin: req.get('origin') || null
        });
    }

    console.error('❌ Unhandled server error:', err);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
});

/* ==========================================
   6. DEPLOYMENT PORT INITIALIZER
========================================== */
const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(` 🚀 Server actively streaming data loops at:`);
    console.log(`     👉 http://localhost:${PORT}`);
    console.log(`=================================================`);
});
