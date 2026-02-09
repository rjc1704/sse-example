import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const prisma = new PrismaClient();
const app = express();

// JWT 시크릿 키
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// SSE 클라이언트 연결을 저장할 Map
const clients = new Map();

// 미들웨어 설정
app.use(
  cors({
    origin: "http://localhost:5500",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, "../public")));

// SSE 연결 엔드포인트
app.get("/notifications/:userId", (req, res) => {
  const userId = parseInt(req.params.userId);

  // SSE 헤더 설정
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // 클라이언트 연결 저장
  console.log("userId:::", userId);
  clients.set(userId, res);

  // 연결이 끊어졌을 때 클라이언트 제거
  req.on("close", () => {
    clients.delete(userId);
  });
});

// 좋아요 생성 엔드포인트
app.post("/posts/:postId/like", async (req, res) => {
  try {
    const postId = parseInt(req.params.postId);
    const userId = parseInt(req.body.userId);

    console.log("요청된 postId:", postId);
    console.log("요청된 userId:", userId);

    // 게시물 작성자 정보 조회
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { author: true },
    });

    console.log("조회된 post:", post);

    if (!post) {
      return res.status(404).json({ message: "게시물을 찾을 수 없습니다." });
    }

    // 이미 좋아요를 눌렀는지 확인
    const existingLike = await prisma.like.findUnique({
      where: {
        userId_postId: {
          userId: userId,
          postId: postId,
        },
      },
    });

    if (existingLike) {
      return res
        .status(400)
        .json({ message: "이미 좋아요를 누른 게시물입니다." });
    }

    // 좋아요 생성
    const like = await prisma.like.create({
      data: {
        userId,
        postId,
      },
    });

    // 게시물 작성자에게 알림 전송
    console.log(
      "현재 연결된 모든 클라이언트:",
      Array.from(clients.entries()).map(([userId, res]) => ({
        userId,
        connected: !!res,
      })),
    );
    const authorClient = clients.get(post.authorId);

    if (authorClient) {
      authorClient.write(
        `data: ${JSON.stringify({
          type: "like",
          message: `userId ${userId}번이 당신의 게시물(postId ${postId}번)에 좋아요를 눌렀습니다!`,
          postId,
          userId,
        })}\n\n`,
      );
    }

    res.json(like);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 게시물 생성 엔드포인트 (테스트용)
app.post("/posts", async (req, res) => {
  try {
    const { title, content, authorId } = req.body;
    const post = await prisma.post.create({
      data: {
        title,
        content,
        authorId,
      },
    });
    res.json(post);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 게시물 목록 조회 엔드포인트 (테스트용)
app.get("/posts", async (req, res) => {
  try {
    const posts = await prisma.post.findMany({
      include: {
        author: {
          select: {
            id: true,
            email: true,
          },
        },
        _count: {
          select: {
            likes: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    res.json(posts);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 사용자 목록 조회 엔드포인트 (테스트용)
app.get("/users", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        createdAt: true,
      },
    });
    res.json(users);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 회원가입 엔드포인트
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    // 이메일 중복 확인
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(400).json({ message: "이미 존재하는 이메일입니다." });
    }

    // 비밀번호 해싱
    const hashedPassword = await bcrypt.hash(password, 10);

    // 사용자 생성
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
      },
    });

    // JWT 토큰 생성
    const token = jwt.sign({ userId: user.id }, JWT_SECRET);

    res.json({ token, userId: user.id });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 데이터베이스 초기화 엔드포인트 (테스트용)
app.delete("/reset", async (req, res) => {
  try {
    // 외래 키 제약 조건 때문에 순서대로 삭제
    await prisma.like.deleteMany({});
    await prisma.post.deleteMany({});
    await prisma.user.deleteMany({});

    res.json({
      message: "모든 데이터가 삭제되었습니다.",
      deleted: {
        likes: "모든 좋아요",
        posts: "모든 게시물",
        users: "모든 사용자",
      },
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ message: "데이터 삭제 중 오류가 발생했습니다." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
