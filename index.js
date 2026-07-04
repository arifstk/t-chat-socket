import express from "express";
import http from "http";
import dotenv from "dotenv";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import axios from "axios";

dotenv.config();
const app = express();

app.use(express.json());
const server = http.createServer(app);
const port = process.env.PORT || 5000;

const io = new Server(server, {
  cors: {
    origin: process.env.NEXT_BASE_URL,
  },
});

// অনলাইন ইউজারদের ট্র্যাক করার জন্য (in-memory map)
const onlineUsers = new Map(); // userId -> socketId

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  let userId = null;

  // ধাপ ১: JWT দিয়ে identity verify
  socket.on("identity", async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET);
      userId = decoded.id;

      onlineUsers.set(userId, socket.id);

      // ইউজারের নিজস্ব রুমে join (personal notification পাঠানোর জন্য)
      socket.join(userId);

      // সবাইকে জানাও এই ইউজার অনলাইন হয়েছে
      io.emit("user-online", { userId });

      await axios.post(`${process.env.NEXT_BASE_URL}/api/socket/connect`, {
        userId,
        socketId: socket.id,
        isOnline: true,
      });

      console.log(`User authenticated: ${userId}`);
    } catch (error) {
      console.log("Invalid token, disconnecting socket");
      socket.disconnect();
    }
  });

  // চ্যাট রুমে join করা
  socket.on("join-room", (chatId) => {
    console.log(`User ${userId} joined room: ${chatId}`);
    socket.join(chatId);
  });

  socket.on("leave-room", (chatId) => {
    socket.leave(chatId);
  });

  // মেসেজ পাঠানো
  socket.on("send-message", async (data) => {
    try {
      const { chatId, text, mediaUrl, mediaType, token } = data;

      // টোকেন ভেরিফাই (extra security layer)
      const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET);

      // Next.js API কল করে DB তে সেভ করা
      const response = await axios.post(
        `${process.env.NEXT_BASE_URL}/api/messages`,
        { chatId, text, mediaUrl, mediaType },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      const savedMessage = response.data.message;

      // রুমের সবাইকে মেসেজ পাঠানো (নিজেসহ, UI sync এর জন্য)
      io.to(chatId).emit("receive-message", savedMessage);
    } catch (error) {
      console.log("Send message error:", error.message);
      socket.emit("message-error", { error: "Failed to send message" });
    }
  });

  // Typing indicator
  socket.on("typing", ({ chatId, userId, userName }) => {
    socket.to(chatId).emit("typing", { chatId, userId, userName });
  });

  socket.on("stop-typing", ({ chatId, userId }) => {
    socket.to(chatId).emit("stop-typing", { chatId, userId });
  });

  // মেসেজ seen হলে
  socket.on("message-seen", async ({ chatId, messageId, userId }) => {
    io.to(chatId).emit("message-seen-update", { messageId, userId });

    try {
      await axios.post(`${process.env.NEXT_BASE_URL}/api/messages/seen`, {
        messageId,
        userId,
      });
    } catch (error) {
      console.log("Error updating seen status:", error.message);
    }
  });

  // ডিসকানেক্ট হ্যান্ডলিং
  socket.on("disconnect", async () => {
    console.log(`User disconnected: ${socket.id}`);

    if (userId) {
      onlineUsers.delete(userId);
      io.emit("user-offline", { userId, lastSeen: new Date() });

      try {
        await axios.post(`${process.env.NEXT_BASE_URL}/api/socket/connect`, {
          userId,
          isOnline: false,
        });
      } catch (error) {
        console.log("Error updating offline status:", error.message);
      }
    }
  });
});

// সার্ভার থেকে সার্ভার নোটিফিকেশন পাঠানোর কমন API
app.post("/notify", (req, res) => {
  const { event, data, socketId, roomId } = req.body;

  if (socketId) {
    io.to(socketId).emit(event, data);
  } else if (roomId) {
    io.to(roomId).emit(event, data);
  } else {
    io.emit(event, data);
  }

  return res.status(200).json({ success: true });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", onlineUsers: onlineUsers.size });
});

server.listen(port, () => {
  console.log(`Socket server is running on port ${port}`);
});
