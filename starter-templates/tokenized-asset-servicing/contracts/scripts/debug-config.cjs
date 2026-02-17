try {
    require('dotenv').config({ path: '../.env' });
    const config = require('../hardhat.config.cjs');
    console.log("Config loaded successfully:", config);
} catch (error) {
    console.error("Error loading config:", error);
}
