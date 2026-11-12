// Formula Home — Supabase configuration
// The anon/public key is safe to expose in client-side code; it only allows
// what the Row Level Security policies in Supabase permit (public insert + public select of approved hosts).
const SUPABASE_URL = 'https://fdequrxnvqzjloyrsthj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkZXF1cnhudnF6amxveXJzdGhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0OTI3MzgsImV4cCI6MjEwMjA2ODczOH0.8hVDwdqooq9H6SS90zE5wIKFfOYMbINsd8rLezUp-Gw';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
