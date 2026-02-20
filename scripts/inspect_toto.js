require('dotenv').config();
const mongoose = require('mongoose');
const Token = require('../models/Token');

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const toto = await Token.findOne({ symbol: 'TOTO' });
        console.log(JSON.stringify(toto, null, 2));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
