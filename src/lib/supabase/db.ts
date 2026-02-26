import { createClient } from '@supabase/supabase-js'
const supabaseUrl = "https://cahyjgtrverpbtjaobdg.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhaHlqZ3RydmVycGJ0amFvYmRnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2Nzk4ODQ5MCwiZXhwIjoyMDgzNTY0NDkwfQ.TdzdUKIs8nYHcyWpaF_HsGDk_54vijHLleMiurcXwOw";

export const sb = createClient(supabaseUrl, supabaseKey);