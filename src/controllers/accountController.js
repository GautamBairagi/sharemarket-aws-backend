const db = require('../config/db');

/**
 * Accounts Page — Hierarchy Accounts (Receivable/Payable)
 *
 * Logic:
 * - SUPERADMIN sees all BROKERs/ADMINs under them
 * - ADMIN sees all BROKERs under them
 * - For each broker: calculate their clients' total PL, brokerage, net
 * - Apply broker's share_pl_pct / share_brokerage_pct from broker_shares
 * - Determine Receivable (broker owes admin) or Payable (admin owes broker)
 */
const getHierarchyAccounts = async (req, res) => {
    try {
        const { fromDate, toDate, roleFilter } = req.query;
        const loggedInId = req.user.id;

        // Build date filter for trades
        let dateFilter = "t.status = 'CLOSED'";
        const dateParams = [];
        if (fromDate) {
            dateFilter += ' AND t.exit_time >= ?';
            dateParams.push(fromDate + ' 00:00:00');
        }
        if (toDate) {
            dateFilter += ' AND t.exit_time <= ?';
            dateParams.push(toDate + ' 23:59:59');
        }

        // Get users under logged-in user
        // roleFilter='BROKER' for BrokerAccountsPage (only brokers)
        // roleFilter=null for AccountsPage (all roles)
        // For BROKER viewing AccountsPage: show own account + clients
        let query = `SELECT u.id, u.username, u.full_name, u.role, bs.share_pl_pct, bs.share_brokerage_pct
                     FROM users u
                     LEFT JOIN broker_shares bs ON bs.user_id = u.id
                     WHERE (u.parent_id = ? OR u.id = ?) AND u.is_demo = 0`;
        let queryParams = [loggedInId, loggedInId];

        if (roleFilter === 'BROKER') {
            query += " AND u.role = 'BROKER'";
        } else {
            // For AccountsPage, show all non-superadmin users (ADMIN, BROKER, TRADER)
            query += " AND u.role IN ('ADMIN', 'BROKER', 'TRADER')";
        }

        const [brokers] = await db.execute(query, queryParams);

        const result = [];

        for (const broker of brokers) {
            // Get all clients under this broker
            // Clients can be assigned to broker in two ways:
            // 1. parent_id = broker.id (created directly by broker)
            // 2. broker_id in client_settings (assigned by admin/superadmin)
            const [clients] = await db.execute(
                `SELECT DISTINCT u.id FROM users u
                 LEFT JOIN client_settings cs ON cs.user_id = u.id
                 WHERE u.role = ? AND (u.parent_id = ? OR cs.broker_id = ?) AND u.is_demo = 0`,
                ['TRADER', broker.id, broker.id]
            );

            if (!clients.length) {
                result.push({
                    brokerId: broker.id,
                    broker: broker.username,
                    fullName: broker.full_name || '',
                    clientPL: '0.00',
                    clientBrokerage: '0.00',
                    clientSwap: '0.00',
                    clientNet: '0.00',
                    plShare: '0.00',
                    brokerageShare: '0.00',
                    swapShare: '0.00',
                    netShare: '0.00',
                    receivablePayable: 'Receivable',
                });
                continue;
            }

            const clientIds = clients.map(c => c.id);
            const placeholders = clientIds.map(() => '?').join(',');

            // Sum of closed trades PnL, Brokerage, and Swap for all clients of this broker
            const [plRows] = await db.execute(
                `SELECT
                    COALESCE(SUM(t.pnl), 0) AS total_pnl,
                    COALESCE(SUM(t.brokerage), 0) AS total_brokerage,
                    COALESCE(SUM(t.swap), 0) AS total_swap
                 FROM trades t
                 WHERE t.user_id IN (${placeholders}) AND ${dateFilter}`,
                [...clientIds, ...dateParams]
            );

            const clientPL = parseFloat(plRows[0]?.total_pnl || 0);
            const clientBrokerage = parseFloat(plRows[0]?.total_brokerage || 0);
            const clientSwap = parseFloat(plRows[0]?.total_swap || 0);
            const clientNet = clientPL - clientBrokerage - clientSwap;

            const plSharePct = parseFloat(broker.share_pl_pct || 0) / 100;
            const brokerageSharePct = parseFloat(broker.share_brokerage_pct || 0) / 100;
            const swapSharePct = parseFloat(broker.share_swap_pct || 0) / 100;

            const plShare = clientPL * plSharePct;
            const brokerageShare = clientBrokerage * brokerageSharePct;
            const swapShare = clientSwap * swapSharePct;
            const netShare = plShare + brokerageShare + swapShare;

            // Receivable = broker owes admin (client lost money, admin profit)
            // Payable    = admin owes broker (client made money, broker gets share)
            const receivablePayable = netShare >= 0 ? 'Payable' : 'Receivable';

            result.push({
                brokerId: broker.id,
                broker: broker.username,
                fullName: broker.full_name || '',
                clientPL: clientPL.toFixed(2),
                clientBrokerage: clientBrokerage.toFixed(2),
                clientSwap: clientSwap.toFixed(2),
                clientNet: clientNet.toFixed(2),
                plShare: plShare.toFixed(2),
                brokerageShare: brokerageShare.toFixed(2),
                swapShare: swapShare.toFixed(2),
                netShare: netShare.toFixed(2),
                receivablePayable,
            });
        }

        res.json(result);
    } catch (err) {
        console.error('[AccountController] getHierarchyAccounts error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const getNegativeBalances = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT id, username, balance FROM users WHERE balance < 0 AND is_demo = 0');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

module.exports = { getHierarchyAccounts, getNegativeBalances };
