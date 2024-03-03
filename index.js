const express = require('express');
const { Client,LocalAuth,MessageMedia ,RemoteAuth} = require('whatsapp-web.js');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Server } = require("socket.io");
const socketIo = require('socket.io');
const http = require('http');
const bodyParser = require('body-parser');
const MONGODB_URI="mongodb://localhost:27017/test-db"

const app = express();
const port = 3000;
const server = http.createServer(app);

var store;

mongoose.connect(MONGODB_URI).then(() => {
    console.log("Hello To connnected MONGODB")
    store = new MongoStore({ mongoose: mongoose });
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

server.listen(3000, () => {
    console.log('listening on *:3000');
});

const allsessionsObject = {};

const createWhatsappSession = async (id, socket) => {
    let client = new Client({
        puppeteer:{
            args: ['--no-sandbox'],
            headless:true,
        },
        authStrategy: new RemoteAuth({
            clientId: id,
            store: store,
            backupSyncIntervalMs: 300000
        }),
    });

    client.on('qr', (qr) => {
        // Generate and scan this code with your phone
        console.log('QR RECEIVED', {qr});
        socket.emit('qr',{qr});
    });

    client.on('authenticated', async (session) => {
        console.log('AUTHENTICATED', session);
        await store.save({ session: session });
    });

    client.on('ready', () => {
        console.log('READY');
        allsessionsObject[id] = client;
        socket.emit('ready',{id, message:'client is ready'});
    });

    client.on('remote_session_saved',()=>{
        console.log('remote-session saved');
        socket.emit('remote_session_saved',{
            message:'remote session saved'
        });
    })

    client.initialize();
}


const getWhatsappSession = async (id,socket) => {
    console.log('getWhatsappSession is READY');
    console.log(id);
    const client = new Client({
        puppeteer:{
            args: ['--no-sandbox'],
            headless:true,
        },
        authStrategy: new RemoteAuth({
            clientId: id,
            store: store,
            backupSyncIntervalMs: 300000
        })
    });

    client.on('ready', () => {
        console.log('wa-client is READY');
        allsessionsObject[id] = client;
        socket.emit('ready',{ id,  message:'client is ready'});
    })

    client.on('qr', (qr) => {
        // Generate and scan this code with your phone
        console.log('QR RECEIVED', { qr });
        socket.emit('qr',{qr,message:'QR RECEIVED when logged out'});
    });

    client.initialize();
};

io.on('connection', (socket) => {
    console.log('a user connected',socket?.id);

    socket.on('disconnect', () => {
        console.log('user disconnected');
    });

    socket.on("connected",(data)=> {
        console.log("Connnected to the server",data)
        socket.emit(data);
    });

    socket.on('createSession', (data) => {
        console.log('creating session for a user', data);
        const { id } = data;
        createWhatsappSession(id, socket)
            .then(() => {
                const successMessage = "Session created successfully";
                socket.emit('sessionCreated', { message: successMessage });
            })
            .catch((error) => {
                const errorMessage = "Failed to create session";
                socket.emit('sessionCreationFailed', { message: errorMessage });
            });
    });

    socket.on('getSession', (data) => {
        console.log('getSession',data);
        const {id} = data;
        getWhatsappSession(id,socket);
    });

    socket.on('getAllChats',async (data)=>{
        console.log('getting all chats',data);
        const {id} = data;
        const client = allsessionsObject[id];
        const chats = await client.getChats();
        socket.emit('allChats',{chats});
    })

    socket.on('sendMessage', async (data) => {
        console.log('sending message', data);
        const { id, number, message,mediaPath } = data;
        const client = allsessionsObject[id];

        let mediaOptions = {};
        if (mediaPath) {
            const mediaFile = await MessageMedia.fromUrl(mediaPath)
            mediaOptions = {
                caption: 'This is a media caption',
                media: mediaFile
            };
        }
        const chats = await client.getChats();
        console.log('chats',chats);
        console.log('data',data);
        /*const messages = await Promise.all(number.map(async number => {
            const msg = await client.sendMessage(`${number}@c.us`, message, mediaOptions);
        }))
            socket.emit('sendMessageSuccess', { message: 'Message sent successfully',msg:messages });
    */
        const msg = await client.sendMessage(`${number}@c.us`, message, mediaOptions);
        socket.emit('sendMessageSuccess', { message: 'Message sent successfully',msg:msg });



        // SendWaMessage(id, socket, numbers, message, mediaPath)
        //   .then(() => {
        //     const successMessage = "message sent successfully";
        //     socket.emit('sessionCreated', { message: successMessage });
        //   })
        //   .catch((error) => {
        //     const errorMessage = "Failed to send message";
        //     socket.emit('mesage sent failed', { message: errorMessage });
        //   });
    });
});






































// const express = require('express');
// const app = express();
// const port = 3000;
// const qrcode = require('qrcode-terminal');
// const { Client, RemoteAuth } = require('whatsapp-web.js');
// const { MongoStore } = require('wwebjs-mongo');
// const mongoose = require('mongoose');

// // Load the session data
// mongoose.connect('mongodb://localhost:27017/test-db').then(() => {
//     const store = new MongoStore({ mongoose: mongoose });
//     const client = new Client({
//         authStrategy: new RemoteAuth({
//             store: store,
//             backupSyncIntervalMs: 300000
//         }),
//         puppeteer: {
//             args: ['--no-sandbox'],
//         }
//     });

//     client.on('qr', (qr) => {
//         qrcode.generate(qr, { small: true });
//         console.log('QR RECEIVED', qr);
//     });
    
//     client.on('ready', () => {
//         console.log('Client is ready!');
//     });
    
//     client.on('remote_session_saved', () => {
//         console.log('save');
//     });

//     client.initialize();
// });


 
 



// mongoose.connect('mongodb://localhost:27017/test-db', {
//     useNewUrlParser: true,
//     useUnifiedTopology: true
// })
// .then(() => {
//     console.log("connected to mongodb");
// })
// .catch((error) => {
//     console.error("error connecting to mongodb: ", error);
// })

// app.listen(port, () => {
//     console.log('server is running on port: '+ port)
// })

// app.get('/hello', (req, res) => {
//     res.json({message: "Hello, Integration Ninjas!"})
   
// });

 