const express = require('express');
const { Client, LocalAuth, RemoteAuth, MessageMedia, Location } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Server } = require("socket.io");
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const crypto = require('crypto');

const http = require('http');
const bodyParser = require('body-parser');
const MONGODB_URI="mongodb://localhost:27017/test-db"

const app = express();
const port = 3000;
const server = http.createServer(app);
const sessions = new Map();
const socketList = new Map();
let store;
const filterType = ['emoji', 'chat', 'ptt','image', 'document', 'video', 'location', 'gif', 'vcard', 'sticker', 'poll_creation', 'audio'];

ffmpeg.setFfmpegPath(ffmpegStatic);

mongoose.connect(MONGODB_URI).then(() => {
    console.log("Hello To connnected MONGODB")
    store = new MongoStore({ mongoose: mongoose });
}).then(() => {
    console.log("connected to mongodb");
})
.catch((error) => {
    console.error("error connecting to mongodb: ", error);
});

const io = new Server(server,{
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
})

app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.send('<h1>Hello world</h1>');
});

app.get('/getMedia', async (req, res) => {
    try { 
        const sessionId = req.query.sessionId;
        const messageId = req.query.messageId;
        const chatId = req.query.chatId;
 
        if (!sessionId || !messageId || !chatId) { throw new Error('Session not Found') }

        const client = sessions.get(sessionId);
        if (!client) { throw new Error('Client not Found') }

        const message = await _getMessageById(client, messageId, chatId)
        if (!message) { throw new Error('Message not Found') }

        const media = await message.downloadMedia();
        const id = message.id.id;
        const filetype = message.type;
        const imageUrl = message.mediaKey;
        var data = media.data;
        if (filetype === 'ptt') {
            convertBase64OggToBase64Mp3(media.data, (err, base64Mp3) => {
                if (err) { throw new Error('Error converting OGG to M4A:', err); }
                data = base64Mp3;
                const result = { id, chatId, filetype, data, imageUrl };
                res.send(JSON.stringify(result));
            });
        } else {
            const result = { id, chatId, filetype, data, imageUrl };
            res.send(JSON.stringify(result));
        }
    } catch (error) {
        console.log(error.message);
        res.send(JSON.stringify(error.message));
    }
});

server.listen(3000, () => {
    console.log('listening on *:3000');
});

const sendMessage = (socket, action, body) => {
    socket.emit(action, JSON.stringify(body));
}

const sendErrorResponse = (socket, status, message) => {
    socket.emit("error", JSON.stringify({ status, message }));
}
const _createWhatsappSession = (id, socket) => {
    const client = new Client({
      puppeteer: {
        headless: false,
      },
      authStrategy: new RemoteAuth({
        clientId: id,
        store: store,
        backupSyncIntervalMs: 300000,
      }),
    });
  
    client.on("qr", (qr) => {
      console.log("QR RECEIVED", qr);
      socket.emit("qr", {
        qr,
      });
    });
  
    client.on("authenticated", () => {
      console.log("AUTHENTICATED");
    });
    client.on("ready", () => {
      console.log("Client is ready!");
      allSessionsObject[id] = client;
      socket.emit("ready", { id, message: "Client is ready!" });
    });
  
    client.on("remote_session_saved", () => {
      console.log("remote_session_saved");
      socket.emit("remote_session_saved", {
        message: "remote_session_saved",
      });
    });
  
    client.initialize();
  };

const createWhatsappSession = async (sessionId, socket) => {
    socketList.set(sessionId, socket);

    if (sessions.has(sessionId)) {
        const client = sessions.get(sessionId);
        const state = await client.getState();
        console.log("AUTH WITH EXISTING SESSION", state)
        sendMessage(socket, 'authenticateStateResponse', { state });
    } else {
        try {
            console.log('creating session for a user', sessionId);

            let client = new Client({
                puppeteer:{
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                    headless: true
                },
                authStrategy: new RemoteAuth({
                    store: store,
                    clientId: sessionId, 
                    backupSyncIntervalMs: 300000
                })
                // authStrategy: new LocalAuth({ clientId: sessionId }),
                // userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15',
            });

            sendMessage(socket, 'authenticateStateResponse', { state: "LOADING" });

            client.initialize().catch(err => console.log('Initialize error:', err.message));
            initializeEvents(client, sessionId);
        } catch {
            console.log('creating session error');
        }
    }
};

const initializeEvents = (client, sessionId) => {
    client.on('loading_screen', (percent, message) => {
        console.log('LOADING SCREEN', percent, message);
    });

    client.on('auth_failure', msg => {
        // Fired if session restore was unsuccessful
        console.error('AUTHENTICATION FAILURE', msg);
    });

    client.on('disconnected', async (session) => {
        console.log('DISCONNECTED: ', sessionId, session);
        sessions.delete(sessionId);
        await client.destroy().catch(e => { });

        const socket = socketList.get(sessionId);
        sendMessage(socket, 'logoutResponse', { sessionId });
    });

    client.on('qr', (qr) => {
        console.log('QR RECEIVED:  ',socket?.id, { qr });

        const socket = socketList.get(sessionId);
        sendMessage(socket, 'qr', { qr });
    });

    client.on('authenticated', async (session) => {
        console.log('AUTHENTICATED: ', sessionId);

        const socket = socketList.get(sessionId);
        sendMessage(socket, 'authenticated', { sessionId });
    });

    client.on('ready', async () => {
        console.log('READY: ', sessionId);
        sessions.set(sessionId, client);

        const state = await client.getState();
        const socket = socketList.get(sessionId);
        sendMessage(socket, 'ready', { state });
    });

    client.on('remote_session_saved', async () => {
        console.log('SESSION SAVED: ', sessionId);

        const socket = socketList.get(sessionId);
        sendMessage(socket, 'saveSession', { sessionId });
    });

    client.on('message', async (msg) => {
        console.log('MESSAGE RECEIVED: ', msg);
        _updateMessageList(msg, false);
    });

    client.on('message_create', async (msg) => {
        console.log('MESSAGE CREATE', msg);
        _updateMessageList(msg, true);
    });

    client.on('message_revoke_everyone', async (msg) => {
        _updateMessageList(msg, true);

        console.log('message_revoke_everyone', msg);
    });

    client.on('message_revoke_me', async (msg) => {
        _updateMessageList(msg, true);
        console.log('message_revoke_me', msg);
    });

    const _updateMessageList = async (msg, isTo) => {
        try {
            const socket = socketList.get(sessionId);
            if (!socket) { return }
            const messageObject = _messageObject(msg);
            sendMessage(socket, 'getMessageListResponse',  [messageObject]);

            const anthor = isTo ? msg.to : msg.from;
            const chat = await client.getChatById(anthor);
            if (!chat) { throw new Error('Chat not Found') }
            
            const chatObject = _getChatObjectWithMessage(chat, messageObject);
            sendMessage(socket, 'getChatListResponse', [chatObject]);

            if (messageObject.type === 'sticker') {
                const chatId = chat.id._serialized;
                const mediaMessage = await _messageMediaObject(msg, chatId, []);
                sendMessage(socket, 'getMessageMediaListResponse',  [mediaMessage]);
            }

        } catch (error) {
            const socket = socketList.get(sessionId);
            sendErrorResponse(socket, 500, error.message)
        }
    }

    client.on('message_ack', async (msg, messageAck) => {
        console.log('MESSAGE ACK', msg, messageAck);
    });

    client.on('media_uploaded', async (msg) => {
        console.log('media_uploaded', msg, messageAck);
    });
};

io.on('connection', (socket) => {
    console.log('a user connected', socket?.id);

    socket.on('disconnect', () => {
        console.log('user disconnected', socket?.id);
    });

    socket.on("connected",(data)=> {
        console.log("Connnected to the server",data)
        socket.emit(data);
    });

    socket.on('createSession', (data) => {
        const { sessionId } = data;
        console.log('createSession');
        _createWhatsappSession(sessionId, socket)
    });

    socket.on('getAuthenticateState',async (data) => {
        try {
            const { sessionId } = data
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }

            const client = sessions.get(sessionId);
            const state = await client.getState();
            sendMessage(socket, 'authenticateStateResponse', { state });
        } catch (error) {
            sendErrorResponse(socket, 500, error.message)
        }
    });

    socket.on('getChatListRequest', async (data) => {
        console.log("getChatListRequest")
        try {
            const { sessionId } = data
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }
            const client = sessions.get(sessionId)

            const chats = await client.getChats();
            if (!chats) { throw new Error('Chats not Found') }

            let results = chats.map( chat => {
                return _getChatObject(chat);
            }).filter(item => item !== null);

            sendMessage(socket, 'getChatListResponse', results);

            let promises = chats.map(async (chat) => {
                const id = chat.id._serialized;
                const chatId = id;
                const filetype = "image";
                const contact = await chat.getContact();
                const imageUrl = await contact.getProfilePicUrl();
                return imageUrl ? { id, imageUrl, filetype, chatId  } : null;
            });
            const images = await Promise.all(promises);
            const filteredResults = images.filter(item => item !== null);

            sendMessage(socket, 'getChatImageListResponse', filteredResults);
        } catch (error) {
            sendErrorResponse(socket, 500, error.message)
        }
    });

    socket.on('getMessageListRequest',async (data) => {
        try {
            const { sessionId, chatId, limit } = data
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }
            
            const client = sessions.get(sessionId)
            const chat = await client.getChatById(chatId);
            if (!chat) { throw new Error('Chat not Found') }
            await chat.sendSeen();

            const messageListData = await chat.fetchMessages({limit: limit});
            var messages = messageListData.map( (message) => {
                return _messageObject(message);
            });
            
            sendMessage(socket, 'getMessageListResponse',  messages);
        } catch (error) {
            sendErrorResponse(socket, 500, error.message)
        }
    });

    socket.on('getMessageMediaListRequest',async (data) => {
        try {
            const { sessionId, chatId, mediaKeys } = data
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }

            const client = sessions.get(sessionId)
            const chat = await client.getChatById(chatId);
            if (!chat) { throw new Error('Chat not Found') }

            const messageListData = await chat.fetchMessages({limit: 100});

            var messages = await Promise.all(messageListData.flatMap(async (message) => {
                return await _messageMediaObject(message, chatId, mediaKeys);
            }));
            messages = messages.filter(item => item !== null);
            sendMessage(socket, 'getMessageMediaListResponse',  messages);
        } catch (error) {
            sendErrorResponse(socket, 500, error.message)
        }
    });

    socket.on('getContactListRequest',async (data) => {
        try {
            const { sessionId } = data
           if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }
            console.log("getContactListRequest")
            const client = sessions.get(sessionId);
            const contacts = await client.getContacts();
            if (!contacts) { throw new Error('Contact not Found') }

            var contactList = contacts.filter(item => item.id.server === 'c.us')
            .map( (contact) => {
                return _contactObject(contact);
            });

            sendMessage(socket, 'getContactListResponse',  contactList);

            let promises = contacts.map(async (contact) => {
                const id = contact.id._serialized;
                const chatId = id;
                const filetype = "image";
                const imageUrl = await contact.getProfilePicUrl();
                return imageUrl ? { id, imageUrl, filetype, chatId  } : null;
            });
            const images = await Promise.all(promises);
            const filteredResults = images.filter(item => item !== null);
            sendMessage(socket, 'getChatImageListResponse', filteredResults);
        } catch (error) {
            sendErrorResponse(socket, 500, error.message)
        }
    });

    socket.on('sendMessageRequest',async (data) => {
        try {
            const { sessionId, chatId, content, contentType } = data;
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }
            const client = sessions.get(sessionId);
            let messageOut;
            let options = {};
            switch (contentType) {
                case 'string':
                    messageOut = await client.sendMessage(chatId, content, options);
                    break;
                case 'media': {
                    const m4aBuffer = Buffer.from(content.data, 'base64');
                    // const tempOggPath = `temp_${crypto.randomBytes(16).toString('hex')}.ogg`;
                    const tempM4aPath = `temp_${crypto.randomBytes(16).toString('hex')}.ogg`;
                    fs.writeFileSync(tempM4aPath, m4aBuffer);
                    const messageMedia = MessageMedia.fromFilePath(tempM4aPath);
                    console.log("MEDIA:");
                    console.log(messageMedia);
                    messageOut = await client.sendMessage(chatId, messageMedia, { sendAudioAsVoice: true });
                    fs.unlinkSync(tempM4aPath);
                    // ffmpeg(tempM4aPath)
                    //     .toFormat('ogg')
                    //     .audioBitrate('24k')
                    //     .on('end', async function() {
                    //         const messageMedia = new MessageMedia(tempOggPath)
                    //         messageOut = await client.sendMessage(chatId, messageMedia, options);
                    //         fs.unlinkSync(tempOggPath);
                    //         fs.unlinkSync(tempM4aPath);

                    //     })
                    //     .on('error', function(err) {
                    //         console.log('An error occurred: ' + err.message);
                    //         fs.unlinkSync(tempOggPath);
                    //         fs.unlinkSync(tempM4aPath);
                    //         callback(err, null);
                    //     })
                    //     .save(tempOggPath);
                    break
                }
                case 'location': {
                    const location = new Location(content.latitude, content.longitude, content.description);
                    console.log(data);
                    messageOut = await client.sendMessage(chatId, location, options);
                    console.log(messageOut);
                    break;
                }
            } 
            sendMessage(socket, 'sendMessageResponse',  messageOut);
        } catch (error) {
            console.log('UserError:', error);
            sendErrorResponse(socket, 500, error.message)
        }
    });

    socket.on('sendReplyMessageRequest',async (data) => {
        try {
            const { sessionId, messageId, chatId, content, destinationChatId} = data
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }

            var options = {};
            const client = sessions.get(sessionId);
            const message = await _getMessageById(client, messageId, chatId);
            if (!message) { throw new Error('Message not Found') }

            const repliedMessage = await message.reply(content, destinationChatId, options);
            sendMessage(socket, 'replyMessageResponse',  repliedMessage);
        } catch (error) {
            sendErrorResponse(socket, 500, error.message)
        }
    });

    //everyone: Bool
    socket.on('sendDeleteMessageRequest',async (data) => {
        try {
            const { sessionId, messageId, chatId, everyone } = data
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }

            const client = sessions.get(sessionId);
            const message = await _getMessageById(client, messageId, chatId)
            if (!message) { throw new Error('Message not Found') }

            const result = await message.delete(everyone)
            sendMessage(socket, 'deleteMessageResponse',  result);
          } catch (error) {
            sendErrorResponse(socket, 500, error.message)
          }
    });

    socket.on('getVoiceMessageRequest', async  (arg, ack) => {
        try {
            const { sessionId, messageId, chatId } = arg
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }
            console.log("MESSAGE");
            const client = sessions.get(sessionId);
            const message = await _getMessageById(client, messageId, chatId)
            if (!message) { throw new Error('Message not Found') }

            const media = await message.downloadMedia();
            convertBase64OggToBase64Mp3(media.data, (err, base64Mp3) => {
                if (err) {
                  console.error('Error converting OGG to M4A:', err);
                  return;
                }
                if (ack) {
                    const id = message.id.id;
                    const filetype = message.type;
                    const imageUrl = message.mediaKey;
                    const data = base64Mp3;
                    const result = { id, chatId, filetype, data, imageUrl };

                    ack(JSON.stringify(result))
                }
            });
          } catch (error) {
            console.log("MESSAGE", error);
            sendErrorResponse(socket, 500, error.message)
          }
    });

    socket.on('getMediaRequest', async  (arg, ack) => {
        try {
            console.log(arg);
            const { sessionId, messageId, chatId } = arg
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }
            console.log("MESSAGE");
            const client = sessions.get(sessionId);
            const message = await _getMessageById(client, messageId, chatId)
            if (!message) { throw new Error('Message not Found') }

            const media = await message.downloadMedia();
            if (ack) {
                const id = message.id.id;
                const filetype = message.type;
                const imageUrl = message.mediaKey;
                const data = media.data;
                const result = { id, chatId, filetype, data, imageUrl };
                ack(JSON.stringify(result))
            }

          } catch (error) {
            console.log("MESSAGE", error);
            sendErrorResponse(socket, 500, error.message)
          }
    });


    socket.on('logoutRequest',async (data) => {
        try {
            const { sessionId } = data;
            if (!checkAuthenticated(sessionId)) { throw new Error('Auth failed') }

            const client = sessions.get(sessionId);

            const contacts = await client.getContacts();
            sendMessage(socket, 'logoutResponse',  contacts);
        } catch (error) {
            sendErrorResponse(socket, 500, error.message)
        }
    });


    const checkAuthenticated = (sessionId) => {
        if (!sessions.has(sessionId)) {
            sendMessage(socket, 'authenticateStateResponse', { state: "UNPAIRED" });
            return false
        }
        return true
    } 
}); 

const _getMessageById = async (client, messageId, chatId) => {
    const chat = await client.getChatById(chatId)
    const messages = await chat.fetchMessages({ limit: 100 })
    const message = messages.find((message) => { return message.id.id === messageId })
    return message
}

const _messageObject = (message) => {
    var messageId = message.id.id;
    var type = message.type;
    var date = message.timestamp;
    var body = message._data?.body;
    var author = message.author;
    var duration = message.duration;
    var ack = message.ack;
    var mediaKey = message.mediaKey;
    var location = message.location;
    var from = message.from;
    var to = message.to;
    var fromMe = message.fromMe;
    var hasMedia = message.hasMedia;
    var hasQuotedMsg = message.hasQuotedMsg;
    var filename = message._data?.filename;
    var quoted = null
    
    if (hasQuotedMsg) {
        var quoteData = message._data;
        var quoteType = quoteData.quotedMsg?.type; 
        var quoteId = quoteData.quotedStanzaID;
        var quoteAnthor = quoteData.quotedParticipant?._serialized;
        var quoteBody =  quoteData.quotedMsg?.body;
        var quoteFilename = quoteData.quotedMsg?.filename
        var quoteDuration = quoteData.quotedMsg?.duration;
        var quoteMediaKey = quoteData.quotedMsg?.mediaKey;

        quoted = { quoteId, quoteAnthor, quoteBody, quoteDuration, quoteType, quoteFilename, quoteMediaKey };
    }
    if (!filterType.includes(type)) {
        body = type;
        type = 'system';
    }
    
    const data = { messageId, filename, body, author, duration, type, ack, date, mediaKey, location, from, to, fromMe, hasMedia, quoted, hasQuotedMsg };
    return data;
}

const _messageMediaObject = async (message, chatId, mediaKeys) => {
    const isCached = !!mediaKeys.find((mediaKey) => { return message.mediaKey === mediaKey });
    if ((message.type == 'sticker')) {
        if (isCached) {
            const id = message.id.id;
            const filetype = message.type;
            const imageUrl = message.mediaKey;
            return { id, chatId, filetype, imageUrl };
        } else {
            const media = await message.downloadMedia();
            const id = message.id.id;
            const filetype = message.type;
            const data = media.data;
            const imageUrl = message.mediaKey;
            return { id, chatId, filetype, data, imageUrl };
        }
    } else {
        return null;
    }
};

const _getChatObject = (chat) => {
    if (!chat.lastMessage) {
        return null;
    }

    const chatId = chat.id._serialized;
    const name = chat.name;
    const date = chat.timestamp;
    const isArchived = chat.archived ?? false;
    const isGroup = chat.isGroup;
    const unreadCount = chat.unreadCount;
    const lastMessage = _messageObject(chat.lastMessage);
    const chatData = { chatId, name, date, isArchived, isGroup, unreadCount, lastMessage };
    return chatData;
};

const _getChatObjectWithMessage = (chat, message) => {
    const chatId = chat.id._serialized;
    const name = chat.name;
    const date = message.date;
    const isArchived = chat.archived ?? false;
    const isGroup = chat.isGroup;
    const unreadCount = chat.unreadCount;
    const lastMessage = message;
    const chatData = { chatId, name, date, isArchived, isGroup, unreadCount, lastMessage };
    return chatData;
};

const _contactObject = (contact) => {
    const contactId = contact.id._serialized;
    const name = contact.name;
    const shortName = contact.shortName;
    const phoneNumber = contact.phoneNumber;
    const type = contact.type;
    const isUser = contact.isUser;
    const isGroup = contact.isGroup;
    const isWAContact = contact.isWAContact;
    const isBlocked = contact.isBlocked;
    const contactData = { contactId, name, shortName, phoneNumber, type, isUser, isGroup, isWAContact, isBlocked };
    return contactData;
};

function convertBase64OggToBase64Mp3(base64Ogg, callback) {
    const oggBuffer = Buffer.from(base64Ogg, 'base64');
    const tempOggPath = `temp_${crypto.randomBytes(16).toString('hex')}.ogg`;
    const tempMp3Path = `temp_${crypto.randomBytes(16).toString('hex')}.mp3`;
    fs.writeFileSync(tempOggPath, oggBuffer);
    ffmpeg(tempOggPath)
        .toFormat('mp3')
        .audioBitrate('24k')
        .on('end', function() {
            const mp3Buffer = fs.readFileSync(tempMp3Path);
            const base64Mp3 = mp3Buffer.toString('base64');
            fs.unlinkSync(tempOggPath);
            fs.unlinkSync(tempMp3Path);
            callback(null, base64Mp3);
        })
        .on('error', function(err) {
            console.log('An error occurred: ' + err.message);
            fs.unlinkSync(tempOggPath);
            fs.unlinkSync(tempMp3Path);
            callback(err, null);
        })
        .save(tempMp3Path);
}
