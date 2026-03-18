const { google } = require('googleapis');
const stream = require('stream');
const fs = require('fs');
require('dotenv').config();

const FOLDER_MESSAGE = process.env.DRIVE_FOLDER_MENSAJE || '';
const FOLDER_IMAGE = process.env.DRIVE_FOLDER_IMAGEN || '';
const FOLDER_LISTADO = process.env.DRIVE_FOLDER_LISTADO || '';
const TOKENS_PATH = process.env.GOOGLE_TOKENS_PATH || './tokens.json';

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

let drive = google.drive({ version: 'v3', auth: oauth2Client });
let isInitialized = false;

// Load tokens if they exist
try {
    if (fs.existsSync(TOKENS_PATH)) {
        const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
        oauth2Client.setCredentials(tokens);
        isInitialized = true;
        console.log('Google Drive API initialized successfully with saved tokens.');
    }
} catch (error) {
    console.error('Error loading saved tokens:', error);
}

// Generate Auth URL for user login
function getAuthUrl() {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // Force refresh token generation
        scope: ['https://www.googleapis.com/auth/drive']
    });
}

// Handle the OAuth callback and save tokens
async function handleCallback(code) {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    isInitialized = true;
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens));
    console.log('Tokens acquired and saved successfully.');
    return tokens;
}

function checkInit() {
    if (!isInitialized) throw new Error('NOT_AUTHENTICATED');
}

async function uploadFile(file, type, customName = null) {
    checkInit();
    let folderId;
    if (type === 'message') folderId = FOLDER_MESSAGE;
    else if (type === 'image') folderId = FOLDER_IMAGE;
    else if (type === 'listado') folderId = FOLDER_LISTADO;
    
    const fileMetadata = {
        name: customName || file.originalname,
        parents: [folderId],
    };

    if (type === 'message' && !fileMetadata.name.endsWith('.txt')) {
        fileMetadata.name += '.txt';
    }

    const media = {
        mimeType: file.mimetype,
        body: bufferToStream(file.buffer),
    };

    const response = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, createdTime',
    });
    return response.data;
}

async function createTextFile(content, fileName = `Mensaje_${Date.now()}.txt`) {
    checkInit();
    const fileMetadata = {
        name: fileName,
        parents: [FOLDER_MESSAGE],
    };

    const media = {
        mimeType: 'text/plain',
        body: content,
    };

    const response = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, createdTime',
    });
    return response.data;
}



async function listRecentFiles(type, pageSize = 10) {
    checkInit();
    let folderId;
    if (type === 'message') folderId = FOLDER_MESSAGE;
    else if (type === 'image') folderId = FOLDER_IMAGE;
    else if (type === 'listado') folderId = FOLDER_LISTADO;
    
    // Only return files if we have a valid folder ID configured
    if (!folderId) return [];
    
    const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        orderBy: 'createdTime desc',
        pageSize: pageSize,
        fields: 'files(id, name, createdTime, mimeType, webViewLink)',
    });
    return response.data.files;
}

async function reuseFile(fileId, type) {
    checkInit();
    let folderId;
    if (type === 'message') folderId = FOLDER_MESSAGE;
    else if (type === 'image') folderId = FOLDER_IMAGE;
    else if (type === 'listado') folderId = FOLDER_LISTADO;
    
    const originalFile = await drive.files.get({
        fileId: fileId,
        fields: 'name'
    });

    const copyMetadata = {
        name: `Reutilizado_${originalFile.data.name}`,
        parents: [folderId]
    };

    const response = await drive.files.copy({
        fileId: fileId,
        resource: copyMetadata,
        fields: 'id, name, createdTime'
    });
    
    return response.data;
}

function bufferToStream(buffer) {
    const streamInstance = new stream.PassThrough();
    streamInstance.end(buffer);
    return streamInstance;
}

module.exports = {
    isInitialized: () => isInitialized,
    getAuthUrl,
    handleCallback,
    uploadFile,
    createTextFile,
    listRecentFiles,
    reuseFile
};
