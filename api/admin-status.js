import {
  getUserFromJwt,
  isAdminEmail,
} from '../lib/analytics-server.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const user = await getUserFromJwt(req.headers.authorization);
  return res.status(200).json({
    isAdmin: !!(user && isAdminEmail(user.email)),
  });
}
