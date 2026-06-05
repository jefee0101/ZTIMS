import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Make sure this is running first!
dotenv.config();

const connectDB = async () => {
    try {
        // Fallback directly to the local string if process.env.MONGO_URI is undefined
        const dbURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/zamboanguita';
        
        await mongoose.connect(dbURI);
        console.log("MongoDB connected successfully to Compass!");
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
};

export default connectDB;