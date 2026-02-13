import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { generateSixDigitCode } from './utils/codeGenerator.js';

const { Client, LocalAuth } = pkg;

// Función para simular espera humana
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const startWhatsApp = async (supabaseAdmin) => {
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    console.log('📌 ESCANEA EL QR');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp Online');
  });

  /* =====================================
     🔒 FUNCIÓN SEGURA: SOLO TELÉFONOS REALES
     ===================================== */
  const getRealPhone = (from) => {
    if (!from.endsWith('@c.us')) return null;
    let phone = from.replace('@c.us', '').replace(/\D/g, '');
    if (!phone.startsWith('591')) return null;
    phone = phone.slice(3);
    if (phone.length !== 8) return null;
    return phone;
  };

  client.on('message', async (msg) => {
    if (msg.fromMe) return;
    if (msg.from.includes('@g.us')) return;

    const phone = getRealPhone(msg.from);

    // 🕒 RESPUESTA HUMANA: Esperar entre 3 y 10 segundos
    const waitTime = Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000;
    
    if (!phone) {
      await delay(waitTime);
      await msg.reply(
        '👋 Para registrarte, envía tu número en este formato:\n\n📱 *591XXXXXXXX*'
      );
      return;
    }

    try {
      const { data: existingMember } = await supabaseAdmin
        .from('members')
        .select('access_code')
        .eq('phone', phone)
        .maybeSingle();

      if (existingMember) {
        await delay(waitTime);
        await msg.reply(`🔐 Tu código de acceso es:\n*${existingMember.access_code}*`);
        return;
      }

      /* ===============================
          CREAR USUARIO
         =============================== */
      const access_code = generateSixDigitCode();
      const email = `${phone}@app.com`;

      const { data: authData, error: authError } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          password: access_code,
          email_confirm: true
        });

      if (authError) throw authError;

      const authId = authData.user.id;

      await supabaseAdmin.from('members').insert({
        id: authId,
        auth_id: authId,
        name: msg._data.notifyName || 'WhatsApp',
        email,
        phone,
        access_code,
        member_type: 2,
        is_verified: 0
      });

      // 📝 VARIANTES DE TEXTO PARA REGISTRO EXITOSO
      const variantes = [
        `✅ *¡Registro completado!* \n\n🔐 Tu código de acceso es: *${access_code}*`,
        `👍 *¡Listo!* Ya estás registrado en el sistema. \n\n🔑 Usa este código para entrar: *${access_code}*`,
        `👋 *¡Bienvenido!* Hemos creado tu cuenta con éxito. \n\n🔐 Tu clave privada es: *${access_code}*`,
        `👋 *¡Hola!* Registro exitoso. \n\n🗝️ Aquí tienes tu código: *${access_code}*`,
        `👍 *¡Bienvenido!* Ya tienes acceso. \n\n🔑 Tu código secreto: *${access_code}*`
      ];

      // Seleccionar una variante al azar
      const mensajeFinal = variantes[Math.floor(Math.random() * variantes.length)];

      // Simular escritura y espera
      await delay(waitTime);
      await msg.reply(mensajeFinal);

    } catch (err) {
      console.error('❌ ERROR:', err.message);
      await delay(2000);
      await msg.reply('⚠️ Ups, hubo un problema técnico. Inténtalo de nuevo en unos minutos.');
    }
  });

  await client.initialize();
};