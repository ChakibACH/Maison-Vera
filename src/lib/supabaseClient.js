import { createClient } from '@supabase/supabase-js';

// These are read from the .env file at the project root (see .env.example).
// After you create your new Supabase project, copy .env.example to .env
// and fill in the two values from Project Settings -> API.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    '[Maison Vera] Missing Supabase environment variables. ' +
    'Create a .env file from .env.example and set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.'
  );
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

// How the site talks to the shared CRM database:
// - "products"        -> read-only here. Rows are created/edited from the CRM dashboard.
// - "contacts"         -> a row is inserted here (type: 'lead') at checkout.
// - "transactions"     -> a row is inserted here (type: 'vente') at checkout.
// - "transaction_items"-> the cart lines for that transaction.
// The exact SQL schema (tables + Row Level Security policies) will be provided
// separately once the new Supabase project is created.
