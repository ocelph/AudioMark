/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import crypto from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import sgMail from "@sendgrid/mail";

// const {setGlobalOptions} = require("firebase-functions");
// const {onRequest} = require("firebase-functions/https");
// const logger = require("firebase-functions/logger");

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
// setGlobalOptions({ maxInstances: 10 });

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

initializeApp();

const sendGridApiKey = defineSecret("SENDGRID_API_KEY");
const auth = getAuth();
const db = getFirestore();

export const reviewUser = onRequest({ secrets: [sendGridApiKey]}, async (request, result) => {
    try {
        console.log("Request received");
        console.log(request.query);
    const {action, token} = request.query;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const snapshot = await db.collection("users").where("tokenHash", "==", tokenHash).limit(1).get()
    sgMail.setApiKey(sendGridApiKey.value());

    console.log("Action:", action);
    console.log(typeof action);
    console.log("Token:", token);

    if (!action || !token) {
        result.status(400).send("Invalid Request");
        return;
    }

    if (action !== "approve" && action !== "deny") {
        result.status(400).send("Invalid Action");
        return;
    }

    if (snapshot.empty) {
        result.status(400).send("Invalid Snapshot");
        return;
    }

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();

    if (userData.status !== "pending") {
        result.send(`User has already been ${userData.status}`);
        return;
    }

    if (action == "approve") {
        await auth.updateUser(userDoc.id, {
            disabled: false,
        });

        await userDoc.ref.update({
            status: "approved",
            tokenHash: FieldValue.delete()
        })

        const msg = {
        to: `${userData.email}`,
        from: 'audiomark.fit3162@gmail.com',
        subject: 'Audiomark Registration Accepted',
        text: `
            Hello ${userData.firstName} ${userData.lastName},

            Your account creation request has been successfully approved
            You can now log in with the credentials associated with this email 

            Thank you for using Audiomark,
            Audiomark Team
        `, 
        html: `
            <h1>Hello ${userData.firstName} ${userData.lastName},</h1>
            <p>Your account creation request has been successfully approved</p>
            <p>You can now log in with the credentials associated with this email</p>

            <br>

            <p>Thank you for using Audiomark,</p>
            <p>Audiomark Team</p>
        `
    }
        await sgMail.send(msg)

        result.send("User approved, Account enabled");

        return;
    }

    if (action == "deny") {
        await userDoc.ref.update({
            status: "denied",
            tokenHash: FieldValue.delete()
        })

        sgMail.setApiKey(sendGridApiKey.value());

        const msg = {
        to: `${userData.email}`,
        from: 'audiomark.fit3162@gmail.com',
        subject: 'Audiomark Registration Denied',
        text: `
            Hello ${userData.firstName} ${userData.lastName},

            Your account creation request has been denied
            Please contact audiomark.fit3162@gmail.com for more information

            Regards,
            Audiomark Team
        `, 
        html: `
            <h1>Hello ${userData.firstName} ${userData.lastName},</h1>
            <p>Your account creation request has been denied</p>
            <p>Please contact audiomark.fit3162@gmail.com for more information</p>

            <br>

            <p>Regards,</p>
            <p>Audiomark Team</p>
        `
    }

        await sgMail.send(msg)

        result.send("User denied, Account disabled");

        return;
    }
    } catch (error) {
        result.status(500).send("Something went wrong")
    }
})

export const registerUser = onCall({ secrets: [sendGridApiKey]}, async (request) =>{
    console.log("Register user function called");

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const {firstName, lastName, email, password } = request.data;

    const approveURL = `https://us-central1-audiomark-94cb2.cloudfunctions.net/reviewUser?action=approve&token=${token}`;
    const denyURL = `https://us-central1-audiomark-94cb2.cloudfunctions.net/reviewUser?action=deny&token=${token}`;

    const user = await auth.createUser({
        email: email,
        password: password,
        displayName: `${firstName} ${lastName}`,
        disabled: true,
    });

    await db.collection("users").doc(user.uid).set({
        firstName: firstName,
        lastName: lastName,
        email: email,
        status: "pending",
        createdAt: new Date().toISOString(),
        tokenHash,
    });

    sgMail.setApiKey(sendGridApiKey.value());

    const msg = {
        to: 'audiomark.fit3162@gmail.com',
        from: 'audiomark.fit3162@gmail.com',
        subject: 'New User Registration',
        text: `
            New User Registration Request

            Name: ${firstName} ${lastName}
            Email: ${email}       
            
            Accept: ${approveURL}
            Deny: ${denyURL}
        `, 
        html: `
            <h1>New User Registration Request</h1>
            <p><strong>Name:</strong> ${firstName} ${lastName}</p>
            <p><strong>Email:</strong> ${email}</p>  

            <br>

            <a href="${approveURL}" style="background-color:#22c55e;
                color:white;
                padding:12px 24px;
                text-decoration:none;
                border-radius:6px;
                display:inline-block;
                margin-right:10px;
                font-weight:bold;
                ">
                Accept
            </a>

            <a href="${denyURL}" style="background-color:#ef4444;
                color:white;
                padding:12px 24px;
                text-decoration:none;
                border-radius:6px;
                display:inline-block;
                margin-right:10px;
                font-weight:bold;
                ">
                Deny
            </a>
        `
    }
    await sgMail.send(msg)

    console.log('Email Sent');

    return  {
        success: true
    };
});