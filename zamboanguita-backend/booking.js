import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
    userId: { type: String, required: true }, // Added to link booking to the logged-in user
    guestName: { type: String, required: true },
    guestEmail: { type: String, required: true },
    nationality: { type: String, required: true },
    phone: { type: String },
    tourGuide: { type: String, default: 'None (Self-Guided)' }, // Already perfect!
    destination: { type: String, required: true },
    checkInDate: { type: String, required: true },
    checkOutDate: { type: String, required: true },
    guestCount: { type: Number, default: 2 },
    companions: { type: Array, default: [] }, // Added to save companion names and ages
    status: { type: String, default: 'pending' }, // Added to support your Admin approval/cancel system
    createdAt: { type: Date, default: Date.now }
});

const Booking = mongoose.model('Booking', bookingSchema);
export default Booking;