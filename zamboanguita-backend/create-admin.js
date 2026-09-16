require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { MONGO_URI, INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD } = process.env;
if (!MONGO_URI || !INITIAL_ADMIN_EMAIL || !INITIAL_ADMIN_PASSWORD) {
  throw new Error('Set MONGO_URI, INITIAL_ADMIN_EMAIL, and INITIAL_ADMIN_PASSWORD before running this script.');
}

const Admin = mongoose.model('Admin', new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true }
}, { collection: 'admins' }));

(async () => {
  await mongoose.connect(MONGO_URI);
  const email = INITIAL_ADMIN_EMAIL.toLowerCase().trim();
  const password = await bcrypt.hash(INITIAL_ADMIN_PASSWORD, 12);
  await Admin.findOneAndUpdate({ email }, { email, password }, { upsert: true, new: true, setDefaultsOnInsert: true });
  await mongoose.disconnect();
  console.log('Admin account created or updated.');
})().catch(async (error) => {
  console.error('Admin bootstrap failed.');
  await mongoose.disconnect();
  process.exit(1);
});
