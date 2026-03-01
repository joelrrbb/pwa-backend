// utils/verifierService.js
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// Necesitamos una instancia local o pasarla desde el server
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

let cachedVerifiers = [];

/**
 * Obtiene los administradores con rol 'verifier' y los guarda en memoria.
 */
export async function updateVerifierCache() {
    try {
        const { data, error } = await supabaseAdmin
            .from('admins') // Ajustado a tu tabla 'admins' según tu código
            .select('name')
            .eq('role', 'verifier')
            .order('id');

        if (!error && data) {
            cachedVerifiers = data;
            console.log(`[Cache] Verificadores actualizados: ${cachedVerifiers.length} activos.`);
        }
    } catch (err) {
        console.error('[Cache Error]:', err);
    }
}

/**
 * Calcula a quién le toca el siguiente registro (Round Robin).
 */
export function getNextVerifier() {
    if (cachedVerifiers.length === 0) return null;
    
    // Usamos el timestamp para rotar (cambia cada segundo)
    const index = Math.floor(Date.now() / 1000) % cachedVerifiers.length;
    return cachedVerifiers[index].name;
}

// Intervalo de 1 hora (3,600,000 ms)
setInterval(updateVerifierCache, 1000 * 60 * 60);

// Primera carga
updateVerifierCache();