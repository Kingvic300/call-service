import { Schema } from 'mongoose';

export interface ApiCredentialDoc {
  apiKey: string;
  secretKeyHash: string;
  serviceName: string;
  active: boolean;
  createdAt: Date;
}

/** One (apiKey, secretKey) pair per integrating service — see AuthService.
 *  secretKeyHash is a bcrypt hash, the plaintext secret is never stored and
 *  is only ever returned to the caller once, at creation time. */
export const ApiCredentialSchema = new Schema<ApiCredentialDoc>(
  {
    apiKey: { type: String, required: true, unique: true, index: true },
    secretKeyHash: { type: String, required: true },
    serviceName: { type: String, required: true },
    active: { type: Boolean, required: true, default: true },
  },
  {
    collection: 'naelixCall',
    timestamps: { createdAt: true, updatedAt: false },
  },
);
