require('dotenv').config();
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const driveService = require('./services/driveService');

const app = express();
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const WORKFLOW_CALLBACK_TOKEN = process.env.WORKFLOW_CALLBACK_TOKEN || null;

// ── Workflow status (in-memory) ──────────────────────────────────────────────
let workflowStatus = { state: 'idle', message: 'Listo para enviar correos', updatedAt: null };
function setStatus(state, message) {
    workflowStatus = { state, message, updatedAt: new Date().toISOString() };
    console.log(`[status] ${state}: ${message}`);
}

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Authorization Middleware
const requireAuth = (req, res, next) => {
    if (!driveService.isInitialized()) {
        return res.redirect('/login');
    }
    next();
};

// --- Views ---

app.get('/login', (req, res) => {
    if (driveService.isInitialized()) return res.redirect('/');
    res.render('login', { authUrl: driveService.getAuthUrl() });
});

app.get('/oauth2callback', async (req, res) => {
    try {
        const code = req.query.code;
        if (code) {
            await driveService.handleCallback(code);
            res.redirect('/');
        } else {
            res.send('Ocurrió un error en la autorización. <a href="/login">Intentar de nuevo</a>');
        }
    } catch (error) {
        console.error('Error during OAuth callback:', error);
        res.send('Error al procesar el código de autorización.');
    }
});

app.get('/', requireAuth, async (req, res) => {
    try {
        const isOriginal = f => !f.name.startsWith('Reutilizado_');
        const listados = (await driveService.listRecentFiles('listado', 15) || []).filter(isOriginal);
        const mensajes = (await driveService.listRecentFiles('message', 3) || []).filter(isOriginal);
        const imagenes = (await driveService.listRecentFiles('image', 3) || []).filter(isOriginal);
        res.render('index', {
            listados,
            mensajes,
            imagenes,
            error: null,
            success: null
        });
    } catch (error) {
        console.error("View Error:", error);
        res.render('index', { listados: [], mensajes: [], imagenes: [], error: 'Error interno o de conexión de Google: ' + error.message, success: null });
    }
});

// --- Status Endpoints ---

// Frontend polls this to know if n8n is still running
app.get('/api/status', requireAuth, (req, res) => {
    res.json(workflowStatus);
});

// n8n calls this at the end of the workflow to signal completion
app.post('/api/workflow-done', (req, res) => {
    const { status, message, token } = req.body;
    if (WORKFLOW_CALLBACK_TOKEN && token !== WORKFLOW_CALLBACK_TOKEN) {
        return res.status(401).json({ error: 'Token inválido' });
    }
    const isError = status === 'error';
    setStatus(isError ? 'error' : 'done', message || (isError ? 'El flujo terminó con errores' : '¡Envío completado exitosamente!'));
    res.json({ received: true });
});

// --- API Endpoints ---

app.post('/api/upload/image', requireAuth, upload.single('imageFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
        const result = await driveService.uploadFile(req.file, 'image');
        res.json({ success: true, file: result });
    } catch (error) {
        res.status(500).json({ error: 'Error al subir la imagen a Drive' });
    }
});

app.post('/api/upload/text', requireAuth, upload.single('textFile'), async (req, res) => {
    try {
        if (req.body.messageContent) {
            const result = await driveService.createTextFile(req.body.messageContent);
            return res.json({ success: true, file: result });
        }
        if (req.file) {
            const result = await driveService.uploadFile(req.file, 'message');
            return res.json({ success: true, file: result });
        }
        res.status(400).json({ error: 'Debes escribir un mensaje o subir un archivo .txt' });
    } catch (error) {
        res.status(500).json({ error: 'Error al procesar el mensaje' });
    }
});

app.post('/api/upload/listado', requireAuth, upload.single('listadoFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
        const result = await driveService.uploadFile(req.file, 'listado');
        res.json({ success: true, file: result });
    } catch (error) {
        res.status(500).json({ error: 'Error al subir el listado a Drive' });
    }
});

app.post('/api/reuse', requireAuth, async (req, res) => {
    try {
        const { fileId, type } = req.body;
        if (!fileId || !type) return res.status(400).json({ error: 'Falta fileId o tipo' });
        const result = await driveService.reuseFile(fileId, type);
        res.json({ success: true, file: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/trigger', requireAuth, async (req, res) => {
    if (!N8N_WEBHOOK_URL) return res.status(500).json({ error: 'URL del webhook no configurada' });
    try {
        const sendEmail = req.body.sendEmail !== undefined ? (req.body.sendEmail === true || req.body.sendEmail === 'true') : true;
        const emailSubject = req.body.emailSubject || '';
        const payload = {
            triggeredBy: 'Node.js Dashboard',
            timestamp: new Date().toISOString(),
            sendEmail: sendEmail,
            emailSubject: emailSubject
        };
        console.log(`[trigger] POST → ${N8N_WEBHOOK_URL}`);
        console.log(`[trigger] Payload:`, JSON.stringify(payload));
        setStatus('running', 'Flujo en ejecución...');
        const response = await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 15000 });
        console.log(`[trigger] n8n respondió con status ${response.status}:`, response.data);
        res.json({ success: true, message: '¡Envío masivo iniciado con éxito!', data: response.data });
    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            console.error('[trigger] Timeout: n8n no respondió en 15s');
            setStatus('error', 'Timeout: n8n no respondió en 15s');
            return res.status(504).json({ error: 'Timeout: n8n no respondió. ¿Está activo el webhook en n8n?' });
        }
        const status = error.response?.status;
        const details = error.response?.data ?? error.message;
        console.error(`[trigger] Error ${status ?? ''}:`, details);
        setStatus('error', `Error n8n (${status ?? 'sin respuesta'})`);
        res.status(500).json({ error: `Error n8n (${status ?? 'sin respuesta'}): ` + JSON.stringify(details) });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    if (!driveService.isInitialized()) {
        console.log(`⚠️  Go to http://localhost:${PORT}/login to authorize Google Drive.`);
    }
});
