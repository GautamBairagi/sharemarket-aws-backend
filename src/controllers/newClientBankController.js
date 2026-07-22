const db = require('../config/db');

// This is a single-record settings table (company payment details shown to new clients)

const getNewClientBank = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM new_client_bank LIMIT 1');
        if (rows.length === 0) {
            return res.json({
                account_holder: '', account_number: '', bank_name: '',
                ifsc: '', phone_pe: '', google_pay: '', paytm: '', upi_id: ''
            });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const updateNewClientBank = async (req, res) => {
    const { accountHolder, accountNumber, bankName, ifsc, phonePe, googlePay, paytm, upiId } = req.body;
    try {
        const [rows] = await db.execute('SELECT id FROM new_client_bank LIMIT 1');
        if (rows.length === 0) {
            await db.execute(
                'INSERT INTO new_client_bank (account_holder, account_number, bank_name, ifsc, phone_pe, google_pay, paytm, upi_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [accountHolder, accountNumber, bankName, ifsc, phonePe, googlePay, paytm, upiId]
            );
        } else {
            await db.execute(
                'UPDATE new_client_bank SET account_holder=?, account_number=?, bank_name=?, ifsc=?, phone_pe=?, google_pay=?, paytm=?, upi_id=? WHERE id=?',
                [accountHolder, accountNumber, bankName, ifsc, phonePe, googlePay, paytm, upiId, rows[0].id]
            );
        }
        res.json({ message: 'Bank details updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { getNewClientBank, updateNewClientBank };
