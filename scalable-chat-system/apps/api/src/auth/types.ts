export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
};

export type AuthenticatedRequest = {
  headers: { authorization?: string };
  user?: AuthenticatedUser;
};
