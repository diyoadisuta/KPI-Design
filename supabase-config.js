/* ========================================
   Supabase Configuration
   KPI Dashboard — Divisi Design
   ======================================== */

const SUPABASE_URL = 'https://nechghbntktjjaoqaezk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cjre4ilGtKJIuwG3fj_t1g_oEvb3RIu';

// Initialize Supabase client
let supabaseClient = null;
try {
  if (typeof supabase !== 'undefined' && supabase.createClient) {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('✅ Supabase client initialized');
  } else {
    console.warn('⚠️ Supabase SDK not loaded, using fallback mode');
  }
} catch (e) {
  console.error('❌ Supabase initialization error:', e);
  supabaseClient = null;
}
