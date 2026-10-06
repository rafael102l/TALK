export type JwtPayload = {
  sub: string;
  phone: string;
  /** Must match User.sessionVersion or the token is rejected. */
  sv: number;
};
