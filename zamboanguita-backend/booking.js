import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
    guestName: { type: String, required: true },
    guestEmail: { type: String, required: true },
    nationality: { type: String, required: true },
    phone: { type: String },
    destination: { type: String, required: true },
    checkInDate: { type: String, required: true },
    checkOutDate: { type: String, required: true },
    guestCount: { type: Number, default: 2 },
    createdAt: { type: Date, default: Date.now }
});

const Booking = mongoose.model('Booking', bookingSchema);
export default Booking;