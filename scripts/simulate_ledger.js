const { logAction } = require('./src/controllers/systemController');
require('dotenv').config();

async function simulateActions() {
    try {
        console.log('Simulating actions...');
        
        await logAction(1, 'TEST_ACTION', 'none', 'This is a test action from simulation script.');
        await logAction(1, 'LOGIN', 'auth', 'User superadmin logged in successfully (SIMULATED)');
        await logAction(1, 'CREATE_USER', 'users', 'Created new user: test_user (SIMULATED)');
        
        console.log('Simulation complete. Check ledger count.');
    } catch (err) {
        console.error('Simulation Failed:', err.message);
    } finally {
        process.exit(0);
    }
}

simulateActions();
