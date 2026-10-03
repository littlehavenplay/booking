// POST /api/rsvp — RETIRED. Party guest lists now live in /api/invite (party
// invitations: the host designs and shares an invitation, guests RSVP on it).
export default async () => new Response(JSON.stringify({
  error: "This guest-list link has been replaced. Use the invitation link in your party confirmation email, or email hello@littlehavenplay.com.",
}), { status: 410, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const config = { path: "/api/rsvp" };
