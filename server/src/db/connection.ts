import mongoose from 'mongoose';
import { config } from '../config.js';

/** Set to true before intentional disconnect to suppress spurious warnings. */
let intentionalDisconnect = false;
let listenersAttached = false;

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(config.mongodbUri);
    console.log('[DB] Connected to MongoDB:', config.mongodbUri);
  } catch (err) {
    console.error('[DB] Failed to connect to MongoDB:', err);
    throw err;
  }

  if (!listenersAttached) {
    mongoose.connection.on('error', (err) => {
      console.error('[DB] MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      if (!intentionalDisconnect) {
        console.warn('[DB] MongoDB disconnected unexpectedly');
      }
    });

    mongoose.connection.on('reconnected', () => {
      console.log('[DB] MongoDB reconnected');
    });

    listenersAttached = true;
  }
}

export async function disconnectDB(): Promise<void> {
  intentionalDisconnect = true;
  await mongoose.disconnect();
  console.log('[DB] Disconnected from MongoDB');
}
