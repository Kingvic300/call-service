export interface AuthenticatedUser {
  /** Matches the backend's user id — used as the mediasoup/room peer identity. */
  id: string;
  displayName: string;
  avatarUrl?: string;
}
