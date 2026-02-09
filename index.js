import express from 'express';
import 'dotenv/config';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import cookieParser from 'cookie-parser';
import { generateSixDigitCode } from './utils/codeGenerator.js';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3001;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// --- MIDDLEWARES ---
// app.use(cors({
  // origin: 'http://localhost:5173', 
  // credentials: true
// }));

app.use(cors({
  origin: '*', // Durante desarrollo esto es lo más fácil para descartar errores
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- MIDDLEWARE: VERIFICAR SESIÓN ---

const checkAuth = async (req, res, next) => {
    const sessionToken = req.cookies.__session || '';
    
    if (!sessionToken) return res.redirect('/login');

    try {
        // 1. Validar el token con Supabase Auth
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(sessionToken);
        
        if (authError || !user) throw new Error("Sesión inválida");

        // 2. NUEVO: Verificar si el UUID del usuario existe en la tabla 'admins'
        const { data: adminData, error: dbError } = await supabaseAdmin
            .from('admins') // El nombre de la tabla que creaste
            .select('id')
            .eq('id', user.id)
            .maybeSingle(); // Retorna null si no lo encuentra en lugar de error

        if (dbError) throw dbError;

        // Si no se encontró en la tabla admins, denegar acceso
        if (!adminData) {
            console.warn(`Intento de acceso denegado para: ${user.email}`);
            // Limpiamos la cookie para que no intente entrar de nuevo automáticamente
            res.clearCookie('__session');
            return res.status(403).render('login', { 
                error: 'No tienes permisos de administrador para acceder a este panel.' 
            });
        }

        // Si todo está bien, guardamos el usuario y continuamos
        req.user = user; 
        next();
    } catch (error) {
        console.error("Error de autenticación/autorización:", error.message);
        res.clearCookie('__session');
        res.redirect('/login');
    }
};

// --- RUTAS DE VISTAS ---

// 1. DASHBOARD (Tabla Layui)
app.get('/', checkAuth, async (req, res) => {
    // Renderizamos la vista principal donde está tu tabla Layui
    res.render('index', { user: req.user });
});

app.get('/login', (req, res) => {
    res.render('login'); 
});

app.get('/api/get-data', checkAuth, async (req, res) => {
  try {
    const { page, limit, name, phone, identity_card } = req.query;
    
    const p = parseInt(page) || 1;
    const l = parseInt(limit) || 10;
    const from = (p - 1) * l;
    const to = from + l - 1;

    let query = supabaseAdmin
      .from('members')
      .select('*', { count: 'exact' });

    // --- FILTRADO POR TEXTO (Usa ilike) ---
    if (name && name.trim() !== "") {
      query = query.ilike('name', `%${name.trim()}%`);
    }

    if (identity_card && identity_card.trim() !== "") {
      query = query.ilike('identity_card', `%${identity_card.trim()}%`);
    }

    // --- FILTRADO POR NÚMERO (Usa eq) ---
    if (phone && phone.trim() !== "") {
      // Al ser numeric, eliminamos cualquier caracter que no sea número
      const numPhone = phone.replace(/\D/g, ''); 
      if (numPhone) {
        query = query.eq('phone', numPhone); 
      }
    }

    const { data: list, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) {
      console.error("Supabase Error:", error.message);
      return res.status(400).json({ code: 1, msg: error.message });
    }

    res.json({
      code: 0,
      msg: '',
      count: count || 0,
      data: list || []
    });

  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ code: 1, msg: "Error interno del servidor" });
  }
})

// Se eliminó 'checkAuth' de los argumentos
app.post('/api/add-user', async (req, res) => {
  try {
    const {
      name,
      phone,
      identity_card,
	  birth_date,
      points,
      referrer_id,
      is_verified,
      locality,
      voting_place,
      voting_table,
      manager_phone,
      member_type,
      tier,
	  id_slot
    } = req.body;

    // Validación básica
    if (!phone) {
      return res.status(400).json({ code: 1, msg: 'El número de teléfono es obligatorio' });
    }

    const email = `${phone}@app.com`;
    const access_code = generateSixDigitCode();

    /* ==========================================================
       1️ VERIFICAR SI EL TELÉFONO YA EXISTE EN MEMBERS
       ========================================================== */
    const { data: userPhone } = await supabaseAdmin
  .from('members')
  .select('id')
  .eq('phone', phone)
  .maybeSingle();

if (userPhone) {
  return res.status(400).json({ code: 1, msg: 'Este número de teléfono ya está registrado' });
}

// Verificar CI (solo si viene)
if (identity_card) {
  const { data: userCI, error: ciError } = await supabaseAdmin
    .from('members')
    .select('id')
    .or(`identity_card.eq.${identity_card}`)  // compara exactamente el valor
    .maybeSingle();

  if (ciError) throw ciError;

  if (userCI) {
    return res.status(400).json({ code: 1, msg: 'Este número de CI ya está registrado' });
  }
}

    /* ==========================================================
       2️ CREAR USUARIO EN SUPABASE AUTH
       ========================================================== */
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: access_code,
      email_confirm: true
    });

    if (authError) throw authError;

    const authId = authData.user.id; 
    const authEmail = authData.user.email;

    /* ==========================================================
       3️ INSERTAR EN LA TABLA MEMBERS 
       ========================================================== */
    const { data: memberData, error: insertError } = await supabaseAdmin
      .from('members')
      .insert({
        id: authId,             
        auth_id: authId,        
        name: name || '',
        email,
        phone,
        identity_card: identity_card || '',
		birth_date: birth_date || null,
        points: parseInt(points) || 0,
        referrer_id,
        access_code,
        is_verified: is_verified ?? 1, 
        locality: locality || '',
        voting_place: voting_place || '',
        voting_table: voting_table || '',
        manager_phone: manager_phone || null,
        member_type: member_type,
        tier: tier || null,
		id_slot: id_slot
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error insertando en members:', insertError);
      // Opcional: Si falla la DB, eliminar el usuario de Auth para evitar huérfanos
      await supabaseAdmin.auth.admin.deleteUser(authId);
      throw insertError;
    }

    /* ==========================================================
       4️ RESPUESTA EXITOSA
       ========================================================== */
    res.json({
      code: 0,
      msg: 'Usuario creado con éxito',
      data: {
        member: memberData,
        auth: { id: authId, email: authEmail, temporary_password: access_code }
      }
    });

  } catch (error) {
    console.error('SUPABASE ERROR:', error);
    res.status(500).json({ 
      code: 1, 
      msg: error.message || 'Error al procesar el registro' 
    });
  }
});



app.post('/api/delete-user', async (req, res) => {
  const { auth_id } = req.body; // Este es el UUID de Supabase Auth

  if (!auth_id) {
    return res.status(400).send({ msg: 'auth_id es obligatorio' });
  }

  try {
   
    const { error: deleteMemberError } = await supabaseAdmin
      .from('members')
      .delete()
      .eq('id', auth_id);

    if (deleteMemberError) throw deleteMemberError;

    const { error: deleteAuthError } = await supabaseAdmin.auth.admin.deleteUser(auth_id);
    
    if (deleteAuthError) throw deleteAuthError;

    res.status(200).send({ msg: 'Usuario borrado correctamente de Auth y Members' });

  } catch (error) {
    console.error('Error borrando usuario:', error);
    res.status(500).send({ msg: 'Error: ' + error.message });
  }
});


app.post('/api/verify-user', async (req, res) => {
  const { uid, name, is_verified } = req.body;

  if (!uid) return res.status(400).send({ msg: 'UID requerido' });

  try {
    // Actualizamos cualquier valor de is_verified
    const { data, error } = await supabaseAdmin
      .from('members')
      .update({ name, is_verified })
      .eq('id', uid)
      .select();

    if (error) throw error;

    res.status(200).send({ msg: 'Usuario actualizado', data });
  } catch (error) {
    res.status(500).send({ msg: error.message });
  }
});
// GET: Obtener referidos de un usuario
app.get('/api/get-referidos', async (req, res) => {
  const { referrer_id } = req.query;

  try {
    const { data, error } = await supabaseAdmin
      .from('members')
      .select('*')
      .eq('referrer_id', referrer_id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({ code: 0, data });
  } catch (error) {
    res.status(500).json({ code: 1, msg: error.message });
  }
});

app.get('/api/posts', checkAuth, async (req, res) => {
  try {
    // 1. Capturar parámetros de paginación de Layui
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    // 2. Calcular el rango (Desde - Hasta)
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // 3. Consultar Supabase
    const { data, error, count } = await supabaseAdmin
      .from('social_media_post')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
	// 4. Responder con el formato que espera Layui
    res.json({
      code: 0,
      msg: "",
      count: count, // Total de registros en la base de datos
      data: data    // Solo los 10 registros de esta página
    });

  } catch (error) {
    console.error('Error obteniendo posts:', error);
    res.status(500).json({ code: 1, msg: error.message, data: [] });
  }
});

app.post('/api/post-update-hidden', checkAuth, async (req, res) => {
  try {
    const { id, blocked } = req.body; // 'blocked' es el nombre que envías en el axios

    const { error } = await supabaseAdmin
      .from('social_media_post')
      .update({ is_hidden: blocked }) // Asegúrate que el campo en DB sea is_hidden
      .eq('id', id);

    if (error) throw error;
    res.json({ code: 0, msg: 'Ok' });
  } catch (error) {
    res.status(500).json({ code: 1, msg: error.message });
  }
});

app.post('/api/post-add', checkAuth, async (req, res) => {
  try {
    const { caption, description, points, thumbnail, link_url, deadline, scope_members, is_fixed } = req.body;

    const { data, error } = await supabaseAdmin
      .from('social_media_post')
      .insert([{
        caption,
        description,
		points,
        thumbnail,
        link_url,
        deadline: deadline || null,
        scope_members: parseInt(scope_members) || 1,
        is_hidden: 0,
      }]);

    if (error) throw error;
    res.json({ code: 0, msg: "Publicación guardada" });
  } catch (error) {
    res.status(500).json({ code: 1, msg: error.message });
  }
});

app.post('/sessionLogin', async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Token no proporcionado' });

    try {
        // 1. Verificar el token
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(idToken);
        if (error || !user) return res.status(401).json({ error: 'Token inválido' });

        // 2. Verificar si es Admin en tu tabla
        const { data: admin } = await supabaseAdmin
            .from('admins')
            .select('id')
            .eq('id', user.id)
            .maybeSingle();

        if (!admin) {
            return res.status(403).json({ error: 'Tu usuario no figura en la lista de administradores.' });
        }

        // 3. Si es admin, crear cookie
        res.cookie('__session', idToken, { /* tus opciones de cookie */ });
        return res.json({ status: 'success' });

    } catch (e) {
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/api/managers', checkAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Consultamos directamente a la VISTA que creamos
    const { data, error, count } = await supabaseAdmin
      .from('view_managers_with_stats') // <-- Usamos el nombre de la vista
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    res.json({
      code: 0,
      msg: "",
      count: count,
      data: data // Aquí 'total_miembros' ya viene calculado por SQL
    });
  } catch (error) {
    res.status(500).json({ code: 1, msg: error.message });
  }
});

app.get('/api/managers-active', checkAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('social_media_manager')
      .select('name, phone')
      .eq('is_hidden', false) // Solo los que no están ocultos
      .order('name', { ascending: true });

    if (error) throw error;
    res.json({ code: 0, data });
  } catch (error) {
    res.status(500).json({ code: 1, msg: error.message });
  }
});

// 2. Actualizar estado "is_hidden" (Switch de la tabla)
app.post('/api/manager-update-hidden', checkAuth, async (req, res) => {
  try {
    const { id, blocked } = req.body; 
    // Convertimos el 1/0 o true/false que envíe el switch
    const status = (blocked === 1 || blocked === true);

    const { error } = await supabaseAdmin
      .from('social_media_manager')
      .update({ is_hidden: status })
      .eq('id', id);

    if (error) throw error;
    res.json({ code: 0, msg: 'Estado actualizado' });
  } catch (error) {
    res.status(500).json({ code: 1, msg: error.message });
  }
});

// 3. Agregar nuevo manager (Para el modal add-manager.html)
app.post('/api/manager-add', checkAuth, async (req, res) => {
  try {
    const { name, phone, team_size } = req.body;

    const { data, error } = await supabaseAdmin
      .from('social_media_manager')
      .insert([{
        name,
        phone,
        team_size: parseInt(team_size) || 0,
        is_hidden: false
      }]);

    if (error) throw error;
    res.json({ code: 0, msg: "Manager agregado con éxito" });
  } catch (error) {
    res.status(500).json({ code: 1, msg: error.message });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const { data, error, count } = await supabaseAdmin
      .from('events')
      .select('id, name, image_link, redirect_link, event_code, is_delete, created_at', { count: 'exact' })
      .order('created_at', { ascending: false }); // sin filtrar is_delete

    if (error) throw error;

    res.json({
      code: 0,
      msg: 'OK',
      count: count,
      data: data
    });
  } catch (err) {
    console.error(err);
    res.json({ code: 1, msg: err.message, count: 0, data: [] });
  }
});

app.post('/api/event-add', async (req, res) => {
  const { name, image_link, redirect_link, event_code } = req.body;

  if (!image_link) {
    return res.status(400).json({ code: 1, msg: 'El campo image_link es obligatorio' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('events')
      .insert([{
        name: name || null,
        image_link,
        redirect_link: redirect_link || null,
		event_code : event_code || null,
        is_delete: false
      }]);

    if (error) throw error;

    res.json({ code: 0, msg: 'Evento agregado', data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 1, msg: err.message });
  }
});

app.post('/api/event-delete', checkAuth, async (req, res) => {
  try {
    const { id, blocked } = req.body; 
    // Convertimos el 1/0 o true/false que envíe el switch
    const status = (blocked === 1 || blocked === true);

    const { error } = await supabaseAdmin
      .from('events')
      .update({ is_delete: status })
      .eq('id', id);

    if (error) throw error;
    res.json({ code: 0, msg: 'Estado actualizado' });
  } catch (error) {
    res.status(500).json({ code: 1, msg: error.message });
  }
});


app.get('/logout', (req, res) => {
    // Borra la cookie del servidor
    res.clearCookie('__session', {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    });
    // Redirige al login de la web (si usas EJS)
    res.redirect('/login');
});


app.get('/posts', checkAuth, (req, res) => {
    res.render('posts', { user: req.user });
});

app.get('/events', checkAuth, (req, res) => {
    res.render('events', { user: req.user });
});

app.get('/managers', checkAuth, (req, res) => {
    res.render('managers', { user: req.user });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});