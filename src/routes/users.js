const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { createClient } = require('@supabase/supabase-js');

// Admin client with service role — needed to invite users via Supabase Auth
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const ALLOWED_DOMAINS = ['edu', 'ac.uk', 'ivey.ca', 'uwo.ca', 'insead.edu'];

function isValidDomain(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  return ALLOWED_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

// POST /api/users/invite
router.post('/invite', async (req, res) => {
  try {
    const { email, name, role } = req.body;
    if (!email || !name || !role) return res.status(400).json({ error: 'email, name and role are required' });
    if (!isValidDomain(email)) return res.status(400).json({ error: 'Email domain not allowed' });
    if (!['student', 'staff', 'super_admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    // Check not already exists
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) return res.status(409).json({ error: 'User already exists' });

    // Create Supabase Auth user and send invite email
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { name, role },
      redirectTo: process.env.FRONTEND_URL + '/login',
    });
    if (authError) throw authError;

    // Create user record in our users table
    const { data: user, error: dbError } = await supabase.from('users').insert({
      id: authUser.user.id,
      organisation_id: '00000000-0000-0000-0000-000000000001',
      email,
      name,
      role,
      can_manage_users: role === 'staff' || role === 'super_admin',
    }).select().single();
    if (dbError) throw dbError;

    res.json({ success: true, user });
  } catch (err) {
    console.error('[Users] Invite error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users — list all users
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, name, role, can_manage_users, created_at, last_login')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id — remove user
router.delete('/:id', async (req, res) => {
  try {
    // Prevent deleting super_admins
    const { data: target } = await supabase
      .from('users')
      .select('role')
      .eq('id', req.params.id)
      .single();

    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin') return res.status(403).json({ error: 'Cannot delete a super admin' });

    await supabaseAdmin.auth.admin.deleteUser(req.params.id);
    await supabase.from('users').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Users] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
