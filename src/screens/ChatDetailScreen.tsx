import Colors from "@/src/constants/colors";
import { useCall } from "@/src/contexts/CallContext";
import {
  deleteChatMessage,
  getAdminConversation,
  getChatConversation,
  getChatMessages,
  markConversationMessagesRead,
  sendChatMessage,
  uploadChatFile,
} from "@/src/services/api";
import { shouldShowCancelPrompt } from "@/src/utils/cancelPromptGuard";
import { resolveSocketUrl } from "@/src/utils/network";
import { CometChat } from "@cometchat/chat-sdk-react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  GestureResponderEvent,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import io, { Socket } from "socket.io-client";
const SOCKET_IO_CLIENT_VERSION = require("socket.io-client/package.json").version;

type MessageStatus = "sending" | "sent" | "delivered" | "read" | "failed";

type Attachment = {
  id: string;
  uri: string;
  name?: string;
  mimeType?: string;
  kind: "image" | "video";
};

type ChatMessage = {
  id: string;
  role: "incoming" | "outgoing";
  content?: string;
  attachments?: Attachment[];
  status: MessageStatus;
  createdAt: number;
  isRecalled?: boolean;
  conversationId?: string;
};

type ConversationStatus = "WAITING" | "ACTIVE" | "ENDED" | "CANCELLED" | string;

const LEGACY_STATUS_WARNING_MESSAGE =
  "Một số tin nhắn cũ có trạng thái không còn được hỗ trợ nên lịch sử có thể bị thiếu. Bạn vẫn có thể tiếp tục trò chuyện bình thường.";

const STATUS_METADATA: Record<
  string,
  {
    label: string;
    description: string;
  }
> = {
  WAITING: {
    label: "Chờ bắt đầu",
    description: "Phiên chưa đến giờ. Bạn có thể xem lịch sử nhưng chưa thể gửi tin nhắn.",
  },
  ACTIVE: {
    label: "Đang diễn ra",
    description: "Phiên đã mở. Bạn có thể chat realtime.",
  },
  ENDED: {
    label: "Đã kết thúc",
    description: "Phiên đã xong. Bạn chỉ có thể xem lại lịch sử.",
  },
  CANCELLED: {
    label: "Đã hủy",
    description: "Phiên này đã bị hủy (có thể do vào trễ hoặc người kia không tham gia).",
  },
  UNKNOWN: {
    label: "Đang cập nhật",
    description: "Hệ thống đang cập nhật trạng thái cuộc trò chuyện.",
  },
};

const normalizeConversationStatus = (status?: string | null): ConversationStatus =>
  (status ?? "").toUpperCase() || "UNKNOWN";

const isLegacyStatusError = (error: any): boolean => {
  const rawMessage = (error?.response?.data?.message ?? error?.message ?? "")
    ?.toString()
    .toLowerCase();
  if (!rawMessage) {
    return false;
  }

  return (
    rawMessage.includes("messagestatusenum") ||
    rawMessage.includes("no enum constant") ||
    rawMessage.includes("sent")
  );
};

const normalizeStatus = (status?: string | null): MessageStatus => {
  const normalized = (status ?? "").toString().toLowerCase();

  switch (normalized) {
    case "sending":
    case "pending":
      return "sending";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
    case "error":
      return "failed";
    case "removed":
    case "deleted":
    case "recalled":
      return "sent";
    case "unread":
    case "sent":
    case "success":
      return "sent";
    default:
      return "sent";
  }
};

const normalizeSystemText = (text?: string | null) => {
  if (!text) {
    return text;
  }
  if (text.toLowerCase() === "chat.session.started") {
    return "Phiên trò chuyện bắt đầu";
  }
  return text;
};

const pickFirstString = (...values: Array<string | number | null | undefined>) => {
  for (const value of values) {
    if (value === null || typeof value === "undefined") {
      continue;
    }

    const normalized = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
    if (normalized.trim().length > 0) {
      return normalized;
    }
  }
  return null;
};

const resolvePartnerCometChatUid = (conversation: any, viewerId: string | null) => {
  if (!conversation) {
    return null;
  }

  const normalizedViewerId = viewerId ? String(viewerId) : null;
  const viewerIsSeer =
    normalizedViewerId &&
    conversation?.seerId &&
    String(conversation.seerId) === normalizedViewerId;
  const viewerIsCustomer =
    normalizedViewerId &&
    conversation?.customerId &&
    String(conversation.customerId) === normalizedViewerId;

  const partnerCandidate = viewerIsSeer
    ? conversation?.customer ?? conversation?.customerProfile
    : viewerIsCustomer
      ? conversation?.seer ?? conversation?.seerProfile
      : conversation?.partner;

  return (
    pickFirstString(
      partnerCandidate?.cometChatUid,
      partnerCandidate?.cometchatUid,
      partnerCandidate?.comet_chat_uid,
      partnerCandidate?.cometUid,
      partnerCandidate?.chatUid,
      partnerCandidate?.uid,
      viewerIsSeer ? conversation?.customerCometChatUid : undefined,
      viewerIsCustomer ? conversation?.seerCometChatUid : undefined,
      conversation?.partner?.cometChatUid,
      conversation?.partner?.cometchatUid,
      conversation?.partner?.comet_chat_uid,
    ) ?? null
  );
};

const mapApiMessage = (
  item: any,
  currentUserId: string | null,
  fallbackConversationId?: string,
): ChatMessage => {
  const senderId = item?.senderId ?? item?.fromUserId ?? item?.authorId ?? null;
  const baseId = String(item?.id ?? item?.messageId ?? Date.now());
  const createdAt =
    typeof item?.createdAt === "number"
      ? item.createdAt
      : new Date(item?.createdAt ?? item?.timestamp ?? Date.now()).getTime();
  const statusRaw = (item?.status ?? item?.messageStatus ?? "")
    ?.toString()
    .toLowerCase();

  const isRecalled =
    statusRaw === "deleted" || Boolean(item?.recalled ?? item?.isRecalled);

  const attachments: Attachment[] = [];

  if (!isRecalled) {
    const imageUrl = item?.imageUrl ?? item?.image ?? null;
    if (typeof imageUrl === "string" && imageUrl.trim().length > 0) {
      attachments.push({
        id: `${baseId}-image`,
        uri: imageUrl,
        name: "image.jpg",
        mimeType: item?.imageMimeType ?? "image/jpeg",
        kind: "image",
      });
    }

    const videoUrl = item?.videoUrl ?? item?.video ?? null;
    if (typeof videoUrl === "string" && videoUrl.trim().length > 0) {
      attachments.push({
        id: `${baseId}-video`,
        uri: videoUrl,
        name: "video.mp4",
        mimeType: item?.videoMimeType ?? "video/mp4",
        kind: "video",
      });
    }
  }

  const rawContent = item?.textContent ?? item?.content ?? item?.text ?? "";
  const normalizedContent = normalizeSystemText(rawContent);

  return {
    id: baseId,
    role:
      senderId && currentUserId && String(senderId) === String(currentUserId) ? "outgoing" : "incoming",
    content: isRecalled ? undefined : (normalizedContent || undefined),
    attachments: attachments.length > 0 ? attachments : undefined,
    status: normalizeStatus(item?.status ?? item?.messageStatus),
    createdAt,
    isRecalled,
    conversationId:
      item?.conversationId
        ? String(item.conversationId)
        : fallbackConversationId
          ? String(fallbackConversationId)
          : undefined,
  };
};

export default function ChatDetailScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  const { startVideoCall, status: callStatus } = useCall();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const socketRef = useRef<Socket | null>(null);
  const readSyncRef = useRef(false);
  const socketBaseUrl = useMemo(() => resolveSocketUrl(), []);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [selectedAttachment, setSelectedAttachment] = useState<Attachment | null>(null);
  const [conversationTitle, setConversationTitle] = useState<string>("Cuộc trò chuyện");
  const [partnerAvatar, setPartnerAvatar] = useState<string | null>(null);
  const [partnerCometChatUid, setPartnerCometChatUid] = useState<string | null>(null);
  const [isPartnerOnline, setIsPartnerOnline] = useState<boolean>(false);
  const [conversationStatus, setConversationStatus] = useState<ConversationStatus>("UNKNOWN");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [socketReadyVersion, setSocketReadyVersion] = useState<number>(0);
  const [socketJoinError, setSocketJoinError] = useState<string | null>(null);
  const [legacyStatusWarning, setLegacyStatusWarning] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<{ type: "info" | "warning" | "error"; message: string } | null>(
    null,
  );
  const [cancelRequestPending, setCancelRequestPending] = useState<boolean>(false);
  const [cancelModalVisible, setCancelModalVisible] = useState<boolean>(false);
  const [incomingCancelModalVisible, setIncomingCancelModalVisible] = useState<boolean>(false);
  const [cancelRequesterName, setCancelRequesterName] = useState<string>("Người dùng");

  const normalizedConversationStatus = useMemo(
    () => normalizeConversationStatus(conversationStatus),
    [conversationStatus],
  );
  const statusMeta = STATUS_METADATA[normalizedConversationStatus] ?? STATUS_METADATA.UNKNOWN;
  const isConversationActive = normalizedConversationStatus === "ACTIVE";
  const isInteractionLocked = !isConversationActive;
  const inputPlaceholder = useMemo(() => {
    switch (normalizedConversationStatus) {
      case "WAITING":
        return "Phiên chưa bắt đầu. Bạn sẽ chat được khi chuyển sang trạng thái ACTIVE.";
      case "ENDED":
        return "Phiên đã kết thúc. Bạn chỉ có thể xem lại nội dung.";
      case "CANCELLED":
        return "Phiên đã bị hủy. Không thể gửi tin nhắn.";
      default:
        return "Nhập tin nhắn...";
    }
  }, [normalizedConversationStatus]);

  // Chỉ cho phép gọi video 1-1 khi có UID của đối tác
  // Không dùng conversationId làm group GUID vì group không tồn tại trong CometChat
  const callTargetId = partnerCometChatUid;
  const callReceiverType = CometChat.RECEIVER_TYPE.USER;
  const isCallDisabled = isInteractionLocked || !callTargetId;

  useEffect(() => {
    if (normalizedConversationStatus === "CANCELLED" || normalizedConversationStatus === "ENDED") {
      setCancelRequestPending(false);
    }
  }, [normalizedConversationStatus]);
  const isCustomer = (userRole ?? "").toUpperCase() === "CUSTOMER";
  const canCancelSession =
    isCustomer &&
    (normalizedConversationStatus === "ACTIVE" || normalizedConversationStatus === "WAITING");
  const cancelButtonDisabled = cancelRequestPending || !canCancelSession;

  const showSessionNotice = useCallback(
    (type: "info" | "warning" | "error", message: string) => {
      setSessionNotice({ type, message });
    },
    [],
  );

  const handleIncomingMessage = useCallback(
    (payload: any) => {
      if (!payload) {
        return;
      }

      try {
        const normalized = mapApiMessage(payload, currentUserId, conversationId);
        if (!normalized?.id) {
          return;
        }

        const sameConversation =
          !!conversationId &&
          normalized.conversationId &&
          String(normalized.conversationId) === String(conversationId);

        setMessages((prev) => {
          if (prev.some((message) => message.id === normalized.id)) {
            return prev.map((message) => (message.id === normalized.id ? normalized : message));
          }

          if (normalized.role === "outgoing") {
            const pendingIndex = prev.findIndex(
              (message) =>
                message.role === "outgoing" &&
                message.status === "sending" &&
                (message.content ?? "") === (normalized.content ?? ""),
            );

            if (pendingIndex !== -1) {
              const clone = [...prev];
              clone[pendingIndex] = normalized;
              return clone.sort((a, b) => a.createdAt - b.createdAt);
            }
          }

          const next = [...prev, normalized];
          next.sort((a, b) => a.createdAt - b.createdAt);
          return next;
        });

        if (sameConversation) {
          socketRef.current?.emit("mark_read", conversationId);
        }
      } catch (error) {
        console.warn("Không thể xử lý tin nhắn realtime", error);
      }
    },
    [conversationId, currentUserId],
  );

  const syncReadReceipts = useCallback(async () => {
    if (!conversationId || !hasPendingReadReceipts || readSyncRef.current) {
      return;
    }
    readSyncRef.current = true;
    try {
      const response = await getChatMessages(conversationId, {
        page: 1,
        limit: 100,
        sortType: "asc",
        sortBy: "createdAt",
      });
      const payload = response?.data?.data;
      const normalized = Array.isArray(payload)
        ? payload
          .map((item: any) => mapApiMessage(item, currentUserId, conversationId))
          .sort((a, b) => a.createdAt - b.createdAt)
        : [];

      if (!normalized.length) {
        return;
      }

      setMessages((prev) => {
        const serverMap = new Map(normalized.map((msg) => [msg.id, msg]));
        let changed = false;
        const merged = prev.map((message) => {
          const serverVersion = serverMap.get(message.id);
          if (!serverVersion) {
            return message;
          }
          serverMap.delete(message.id);
          const nextMessage = {
            ...message,
            status: serverVersion.status,
            isRecalled: serverVersion.isRecalled,
            content: serverVersion.isRecalled ? undefined : serverVersion.content,
            attachments: serverVersion.attachments,
            createdAt: serverVersion.createdAt,
          };
          if (
            message.status !== nextMessage.status ||
            message.isRecalled !== nextMessage.isRecalled
          ) {
            changed = true;
          }
          return nextMessage;
        });

        if (serverMap.size > 0) {
          changed = true;
          serverMap.forEach((msg) => merged.push(msg));
        }

        if (!changed) {
          return prev;
        }

        merged.sort((a, b) => a.createdAt - b.createdAt);
        return merged;
      });
    } catch (error) {
      console.warn("Không thể đồng bộ trạng thái đã xem", error);
    } finally {
      readSyncRef.current = false;
    }
  }, [conversationId, currentUserId, hasPendingReadReceipts]);

  const emitSocketMessage = useCallback(
    (payload: {
      conversationId: string;
      textContent?: string;
      imagePath?: string;
      videoPath?: string;
    }) =>
      new Promise<void>((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket || !socketConnected) {
          reject(new Error("Socket chưa sẵn sàng"));
          return;
        }

        socket.emit("send_message", payload, (status: string, message?: string) => {
          if (status === "success") {
            resolve();
          } else {
            reject(new Error(message ?? "Không thể gửi tin nhắn qua socket"));
          }
        });
      }),
    [socketConnected],
  );

  const handleSessionActivated = useCallback(
    (data: any) => {
      setConversationStatus("ACTIVE");
      const message = data?.message ?? "Phiên trò chuyện bắt đầu";
      showSessionNotice("info", message);
      Alert.alert("Phiên đã bắt đầu", message);
    },
    [showSessionNotice],
  );

  const handleSessionCanceled = useCallback(
    (data: any) => {
      setConversationStatus("CANCELLED");
      setCancelRequestPending(false);
      const message =
        data?.message ??
        (data?.reason
          ? `Phiên đã bị hủy: ${data.reason}`
          : "Phiên đã bị hủy. Vui lòng đặt lại lịch nếu cần.");
      showSessionNotice("error", message);
      Alert.alert("Phiên đã bị hủy", message);
    },
    [showSessionNotice],
  );

  const handleSessionEndingSoon = useCallback(
    (data: any) => {
      const remaining = data?.remainingMinutes ?? 10;
      const message =
        data?.message ?? `Phiên sẽ kết thúc trong khoảng ${remaining} phút nữa. Hãy hoàn tất cuộc trò chuyện.`;
      showSessionNotice("warning", message);
    },
    [showSessionNotice],
  );

  const handleSessionEnded = useCallback(
    (data: any) => {
      setConversationStatus("ENDED");
      const message = data?.message ?? "Phiên đã kết thúc. Bạn có thể xem lại lịch sử cuộc trò chuyện.";
      showSessionNotice("info", message);
      Alert.alert("Phiên đã kết thúc", message);
    },
    [showSessionNotice],
  );

  const respondCancelRequest = useCallback(
    (confirmed: boolean) => {
      if (!conversationId || !socketRef.current) {
        Alert.alert("Không thể phản hồi", "Không tìm thấy phiên trò chuyện hoặc kết nối realtime.");
        return;
      }

      socketRef.current.emit(
        "respond_cancel_request",
        { conversationId, confirmed },
        (status?: string, message?: string) => {
          if (status !== "success") {
            Alert.alert("Không thể gửi phản hồi", message ?? "Vui lòng thử lại sau.");
          }
        },
      );
    },
    [conversationId],
  );

  const handleIncomingCancelRequest = useCallback(
    (data: any) => {
      const targetConversationId = data?.conversationId ?? data?.conversationID ?? data?.conversation_id;
      if (conversationId && targetConversationId && String(targetConversationId) !== String(conversationId)) {
        return;
      }

      if (!shouldShowCancelPrompt(targetConversationId)) {
        return;
      }

      const requesterName = data?.requesterName ?? data?.requesterId ?? "Người dùng";
      setCancelRequesterName(requesterName.toString());
      setIncomingCancelModalVisible(true);
    },
    [conversationId, respondCancelRequest],
  );

  const handleCancelResult = useCallback(
    (data: any) => {
      const targetConversationId = data?.conversationId ?? data?.conversationID ?? data?.conversation_id;
      if (conversationId && targetConversationId && String(targetConversationId) !== String(conversationId)) {
        return;
      }

      setCancelRequestPending(false);

      const status = (data?.status ?? "success").toString().toLowerCase();
      const message =
        data?.message ??
        (status === "declined"
          ? "Đối phương đã từ chối hủy phiên."
          : "Phiên đã được hủy. Bạn có thể đặt lịch lại nếu cần.");

      if (status === "success") {
        setConversationStatus("CANCELLED");
        showSessionNotice("error", message);
        Alert.alert("Phiên đã bị hủy", message);
      } else {
        showSessionNotice("info", message);
        Alert.alert("Phiên tiếp tục", message);
      }
    },
    [conversationId, showSessionNotice],
  );

  const handleRequestCancelSession = useCallback(() => {
    if (!conversationId) {
      Alert.alert("Không thể hủy phiên", "Không tìm thấy cuộc trò chuyện phù hợp.");
      return;
    }

    if (!socketRef.current || !socketConnected) {
      Alert.alert("Kết nối realtime chưa sẵn sàng", "Vui lòng kiểm tra kết nối và thử lại.");
      return;
    }

    setCancelModalVisible(true);
  }, [conversationId, showSessionNotice, socketConnected]);

  const confirmCancelSession = useCallback(() => {
    if (!conversationId || !socketRef.current) {
      Alert.alert("Không thể hủy phiên", "Không tìm thấy cuộc trò chuyện hoặc kết nối realtime.");
      setCancelModalVisible(false);
      return;
    }

    setCancelRequestPending(true);
    socketRef.current.emit(
      "cancel_session_manually",
      conversationId,
      (status?: string, message?: string) => {
        if (status === "success") {
          showSessionNotice("warning", "Đã gửi yêu cầu hủy phiên. Đang chờ phản hồi.");
          setCancelModalVisible(false);
        } else {
          setCancelRequestPending(false);
          setCancelModalVisible(false);
          Alert.alert("Không thể gửi yêu cầu", message ?? "Vui lòng thử lại sau.");
        }
      },
    );
  }, [conversationId, showSessionNotice]);

  const handleAcceptIncomingCancel = useCallback(() => {
    respondCancelRequest(true);
    setIncomingCancelModalVisible(false);
  }, [respondCancelRequest]);

  const handleDeclineIncomingCancel = useCallback(() => {
    respondCancelRequest(false);
    setIncomingCancelModalVisible(false);
  }, [respondCancelRequest]);

  const handleUserJoined = useCallback(
    (data: any) => {
      if (!data?.userId) {
        return;
      }
      setIsPartnerOnline(true);
      showSessionNotice("info", `Người dùng ${data.userId} vừa tham gia cuộc trò chuyện.`);
      syncReadReceipts();
    },
    [showSessionNotice, syncReadReceipts],
  );

  const handleUserLeft = useCallback(
    (data: any) => {
      if (!data?.userId) {
        return;
      }
      setIsPartnerOnline(false);
      showSessionNotice("info", `Người dùng ${data.userId} đã rời cuộc trò chuyện.`);
    },
    [showSessionNotice],
  );

  useEffect(() => {
    let active = true;
    const loadUserContext = async () => {
      try {
        const [storedId, storedRole] = await Promise.all([
          SecureStore.getItemAsync("userId"),
          SecureStore.getItemAsync("userRole"),
        ]);
        if (active) {
          setCurrentUserId(storedId ?? null);
          setUserRole(storedRole ?? null);
        }
      } catch (err) {
        console.error(err);
      }
    };

    loadUserContext();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!currentUserId || !socketBaseUrl) {
      return;
    }

    console.log(
      `[SocketIO] client v${SOCKET_IO_CLIENT_VERSION} connecting to ${socketBaseUrl}/chat (user ${currentUserId})`,
    );

    const socket = io(`${socketBaseUrl}/chat`, {
      transports: ["websocket", "polling"],
      autoConnect: false,
      forceNew: true,
      query: { userId: currentUserId, EIO: 3 },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
      timeout: 8000,
    });

    socketRef.current = socket;
    setSocketJoinError(null);
    setSocketConnected(false);

    const handleConnect = () => {
      setSocketConnected(true);
      setSocketJoinError(null);
      setSocketReadyVersion((prev) => prev + 1);
    };

    const handleDisconnect = () => {
      setSocketConnected(false);
      setSocketReadyVersion((prev) => prev + 1);
    };

    const handleConnectError = (error: any) => {
      console.warn("Socket connect error", error);
      const fallbackMessage = "Không thể kết nối realtime. Hệ thống sẽ tự thử lại.";
      const detail = error?.message ? ` (${error.message})` : "";
      setSocketJoinError(`${fallbackMessage}${detail}`);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("receive_message", handleIncomingMessage);
    socket.on("session_activated", handleSessionActivated);
    socket.on("session_canceled", handleSessionCanceled);
    socket.on("session_cancelled", handleSessionCanceled);
    socket.on("session_ending_soon", handleSessionEndingSoon);
    socket.on("session_ended", handleSessionEnded);
    socket.on("request_cancel_confirmation", handleIncomingCancelRequest);
    socket.on("cancel_result", handleCancelResult);
    socket.on("user_joined", handleUserJoined);
    socket.on("user_left", handleUserLeft);

    socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("receive_message", handleIncomingMessage);
      socket.off("session_activated", handleSessionActivated);
      socket.off("session_canceled", handleSessionCanceled);
      socket.off("session_cancelled", handleSessionCanceled);
      socket.off("session_ending_soon", handleSessionEndingSoon);
      socket.off("session_ended", handleSessionEnded);
      socket.off("request_cancel_confirmation", handleIncomingCancelRequest);
      socket.off("cancel_result", handleCancelResult);
      socket.off("user_joined", handleUserJoined);
      socket.off("user_left", handleUserLeft);
      socket.disconnect();
      socketRef.current = null;
      setSocketConnected(false);
    };
  }, [
    currentUserId,
    handleIncomingMessage,
    handleSessionActivated,
    handleSessionCanceled,
    handleSessionEndingSoon,
    handleSessionEnded,
    handleIncomingCancelRequest,
    handleCancelResult,
    handleUserJoined,
    handleUserLeft,
    socketBaseUrl,
  ]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      scrollToEnd();
    }
  }, [messages, scrollToEnd]);

  useEffect(() => {
    if (!conversationId || !socketConnected) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    let cancelled = false;

    socket.emit("join_conversation", conversationId, (status: string, message?: string) => {
      if (cancelled) {
        return;
      }

      if (status !== "success") {
        setSocketJoinError(message ?? "Không thể tham gia cuộc trò chuyện");
      } else {
        setSocketJoinError(null);
        socket.emit("mark_read", conversationId);
      }
    });

    return () => {
      cancelled = true;
      socket.emit("leave_conversation", conversationId, () => { });
    };
  }, [conversationId, socketConnected, socketReadyVersion]);

  const fetchMessages = useCallback(
    async (options: { silent?: boolean; refreshing?: boolean; skipConversationMeta?: boolean } = {}) => {
      if (!conversationId) {
        return;
      }

      const { silent = false, refreshing = false, skipConversationMeta = false } = options;

      if (refreshing) {
        setIsRefreshing(true);
      } else if (!silent) {
        setIsLoading(true);
      }

      try {
        setLoadError(null);
        const isAdmin = (userRole ?? "").toUpperCase() === "ADMIN";
        const [messagesResult, conversationResult] = await Promise.allSettled([
          getChatMessages(conversationId, {
            page: 1,
            limit: 100,
            sortType: "asc",
            sortBy: "createdAt",
          }),
          skipConversationMeta
            ? Promise.resolve({ data: { data: null } })
            : (isAdmin ? getAdminConversation(conversationId) : getChatConversation(conversationId)),
        ]);

        const conversation = conversationResult.status === "fulfilled"
          ? conversationResult.value?.data?.data ?? null
          : null;

        if (!skipConversationMeta) {
          if (conversationResult.status !== "fulfilled") {
            throw conversationResult.reason ?? new Error("Không thể tải cuộc trò chuyện");
          }

          if (conversation) {
            if (conversation.status || conversation.conversationStatus) {
              setConversationStatus(
                normalizeConversationStatus(conversation.status ?? conversation.conversationStatus),
              );
            }
            const viewerIsSeer =
              currentUserId &&
              conversation.seerId &&
              String(conversation.seerId) === String(currentUserId);
            const viewerIsCustomer =
              currentUserId &&
              conversation.customerId &&
              String(conversation.customerId) === String(currentUserId);

            if (viewerIsSeer) {
              setConversationTitle(conversation.customerName ?? "Khách hàng");
              setPartnerAvatar(conversation.customerAvatarUrl ?? null);
            } else if (viewerIsCustomer) {
              setConversationTitle(conversation.seerName ?? "Nhà tiên tri");
              setPartnerAvatar(conversation.seerAvatarUrl ?? null);
            } else {
              setConversationTitle(
                conversation.seerName ?? conversation.customerName ?? "Cuộc trò chuyện",
              );
              setPartnerAvatar(
                conversation.seerAvatarUrl ?? conversation.customerAvatarUrl ?? null,
              );
            }

            // Debug: Log conversation để kiểm tra cấu trúc data
            console.log("[DEBUG] ===== CONVERSATION DEBUG START =====");
            console.log("[DEBUG] Conversation object:", JSON.stringify(conversation, null, 2));
            console.log("[DEBUG] Current user ID:", currentUserId);
            console.log("[DEBUG] Seer ID:", conversation?.seerId);
            console.log("[DEBUG] Customer ID:", conversation?.customerId);
            console.log("[DEBUG] Seer data:", conversation?.seer);
            console.log("[DEBUG] Seer CometChat UID:", conversation?.seer?.cometChatUid);
            console.log("[DEBUG] Customer data:", conversation?.customer);
            console.log("[DEBUG] Customer CometChat UID:", conversation?.customer?.cometChatUid);
            console.log("[DEBUG] Direct seerCometChatUid:", conversation?.seerCometChatUid);
            console.log("[DEBUG] Direct customerCometChatUid:", conversation?.customerCometChatUid);

            const remoteUid = resolvePartnerCometChatUid(conversation, currentUserId);
            console.log("[DEBUG] Resolved partner CometChat UID:", remoteUid);
            console.log("[DEBUG] ===== CONVERSATION DEBUG END =====");

            setPartnerCometChatUid(remoteUid);

            setIsPartnerOnline(
              (conversation.status ?? "").toString().toUpperCase() === "ACTIVE",
            );
          } else {
            setPartnerCometChatUid(null);
          }

          markConversationMessagesRead(conversationId).catch((err) => {
            console.warn("Không thể đánh dấu đã đọc:", err);
          });
        }

        let legacyError = false;
        let rawMessages: any[] = [];

        if (messagesResult.status === "fulfilled") {
          const messagePayload = messagesResult.value?.data?.data;
          rawMessages = Array.isArray(messagePayload) ? messagePayload : [];
        } else if (isLegacyStatusError(messagesResult.reason)) {
          legacyError = true;
        } else {
          throw messagesResult.reason;
        }

        if (!legacyError) {
          const normalized = rawMessages
            .map((item: any) => mapApiMessage(item, currentUserId, conversationId))
            .sort((a, b) => a.createdAt - b.createdAt);
          setMessages(normalized);

          if (legacyStatusWarning) {
            setLegacyStatusWarning(null);
          }
        } else {
          setLegacyStatusWarning(LEGACY_STATUS_WARNING_MESSAGE);
        }
      } catch (error: any) {
        console.error(error);
        if (isLegacyStatusError(error)) {
          setLegacyStatusWarning(LEGACY_STATUS_WARNING_MESSAGE);
          setLoadError(null);
        } else {
          const message =
            error?.response?.data?.message ??
            "Không thể tải lịch sử trò chuyện. Vui lòng thử lại.";
          setLoadError(message);
        }
      } finally {
        if (refreshing) {
          setIsRefreshing(false);
        } else if (!silent) {
          setIsLoading(false);
        }
      }
    },
    [conversationId, currentUserId, legacyStatusWarning, userRole],
  );

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    if (!conversationId || !hasPendingReadReceipts) {
      return;
    }
    let cancelled = false;
    const interval = setInterval(() => {
      if (!cancelled) {
        syncReadReceipts();
      }
    }, 5000);
    syncReadReceipts();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversationId, hasPendingReadReceipts, syncReadReceipts]);

  const handlePickImage = useCallback(async () => {
    if (isInteractionLocked) {
      Alert.alert("Phiên đã khóa", statusMeta.description);
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "image/*",
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled || !result.assets?.length) {
        return;
      }

      const asset = result.assets.find((item) => item?.uri);
      if (!asset?.uri) {
        return;
      }

      setSelectedAttachment({
        id: `${Date.now()}`,
        uri: asset.uri,
        name: asset.name ?? undefined,
        mimeType: asset.mimeType ?? "image/jpeg",
        kind: "image",
      });
    } catch (err) {
      console.error(err);
      Alert.alert("Không thể chọn ảnh", "Vui lòng thử lại sau.");
    }
  }, [isInteractionLocked, statusMeta.description]);

  const handlePickVideo = useCallback(async () => {
    if (isInteractionLocked) {
      Alert.alert("Phiên đã khóa", statusMeta.description);
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "video/*",
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled || !result.assets?.length) {
        return;
      }

      const asset = result.assets.find((item) => item?.uri);
      if (!asset?.uri) {
        return;
      }

      setSelectedAttachment({
        id: `${Date.now()}`,
        uri: asset.uri,
        name: asset.name ?? undefined,
        mimeType: asset.mimeType ?? "video/mp4",
        kind: "video",
      });
    } catch (err) {
      console.error(err);
      Alert.alert("Không thể chọn video", "Vui lòng thử lại sau.");
    }
  }, [isInteractionLocked, statusMeta.description]);

  const handleVideoCallPress = useCallback(async () => {
    if (isInteractionLocked) {
      Alert.alert("Phiên đã kết thúc", statusMeta.description);
      return;
    }
    if (!callTargetId) {
      Alert.alert(
        "Cuộc gọi video",
        "Không thể thực hiện cuộc gọi. Thông tin đối tác chưa sẵn sàng hoặc phiên chưa được kích hoạt."
      );
      return;
    }

    try {
      await startVideoCall(callTargetId, callReceiverType);
    } catch (err) {
      console.error("Không thể bắt đầu cuộc gọi video", err);
      Alert.alert("Cuộc gọi video", "Không thể bắt đầu cuộc gọi. Vui lòng thử lại.");
    }
  }, [callReceiverType, callTargetId, isInteractionLocked, startVideoCall, statusMeta.description]);

  const [isAttachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  const [messageMenuState, setMessageMenuState] = useState<{
    message: ChatMessage;
    x: number;
    y: number;
  } | null>(null);

  const handleAttachmentMenu = useCallback(() => {
    if (isInteractionLocked) {
      Alert.alert("Phiên đã khóa", statusMeta.description);
      return;
    }
    setAttachmentMenuVisible((prev) => !prev);
  }, [isInteractionLocked, statusMeta.description]);

  const handleSelectImageFromMenu = useCallback(() => {
    setAttachmentMenuVisible(false);
    handlePickImage();
  }, [handlePickImage]);

  const handleSelectVideoFromMenu = useCallback(() => {
    setAttachmentMenuVisible(false);
    handlePickVideo();
  }, [handlePickVideo]);

  const handleRemoveAttachment = useCallback(() => {
    setSelectedAttachment(null);
  }, []);

  const closeMessageMenu = useCallback(() => {
    setMessageMenuState(null);
  }, []);

  const handleSendMessage = useCallback(async () => {
    const trimmed = input.trim();
    const attachment = selectedAttachment;

    if (isSending || (!trimmed && !attachment)) {
      return;
    }
    if (!conversationId) {
      Alert.alert("Không thể gửi tin nhắn", "Không tìm thấy cuộc trò chuyện phù hợp.");
      return;
    }

    if (!isConversationActive) {
      Alert.alert("Không thể gửi tin nhắn", statusMeta.description);
      return;
    }

    const localId = `${Date.now()}`;
    const optimisticAttachments = attachment ? [attachment] : undefined;

    const optimisticMessage: ChatMessage = {
      id: localId,
      role: "outgoing",
      content: trimmed.length > 0 ? trimmed : undefined,
      attachments: optimisticAttachments,
      status: "sending",
      createdAt: Date.now(),
      conversationId,
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    setInput("");
    setSelectedAttachment(null);
    setIsSending(true);
    scrollToEnd();

    try {
      let mediaPayload: { imagePath?: string; videoPath?: string } = {};
      if (attachment) {
        const uploadForm = new FormData();
        // Backend requires conversationId when uploading media; add it explicitly
        uploadForm.append("conversationId", conversationId);
        const fieldName = attachment.kind === "video" ? "video" : "image";
        uploadForm.append(
          fieldName,
          {
            uri: attachment.uri,
            name:
              attachment.name ??
              `${attachment.id}.${attachment.kind === "video" ? "mp4" : "jpg"}`,
            type:
              attachment.mimeType ??
              (attachment.kind === "video" ? "video/mp4" : "image/jpeg"),
          } as any,
        );

        const uploadResponse = await uploadChatFile(uploadForm);
        const uploadData = uploadResponse?.data?.data ?? {};
        if (uploadData?.imagePath) {
          mediaPayload.imagePath = uploadData.imagePath;
        }
        if (uploadData?.videoPath) {
          mediaPayload.videoPath = uploadData.videoPath;
        }
      }

      const payload = {
        conversationId,
        ...(trimmed.length > 0 ? { textContent: trimmed } : {}),
        ...(mediaPayload.imagePath ? { imagePath: mediaPayload.imagePath } : {}),
        ...(mediaPayload.videoPath ? { videoPath: mediaPayload.videoPath } : {}),
      };

      let sentViaSocket = false;

      if (socketConnected && socketRef.current) {
        try {
          await emitSocketMessage(payload);
          sentViaSocket = true;
        } catch (socketError) {
          console.warn("Gửi tin nhắn qua socket thất bại, chuyển qua REST API", socketError);
        }
      }

      if (!sentViaSocket) {
        const response = await sendChatMessage(conversationId, payload);
        const apiMessage = response?.data?.data;

        if (apiMessage) {
          const normalizedMessage = mapApiMessage(apiMessage, currentUserId, conversationId);
          setMessages((prev) => {
            const filtered = prev.filter((message) => message.id !== localId);
            const next = [...filtered, normalizedMessage];
            next.sort((a, b) => a.createdAt - b.createdAt);
            return next;
          });
        } else {
          await fetchMessages({ silent: true });
        }
      }
    } catch (error: any) {
      console.error("Send message failed", error);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === localId ? { ...message, status: "failed" } : message,
        ),
      );
      const errorMessage =
        error?.response?.data?.message ??
        error?.message ??
        "Không thể gửi tin nhắn. Vui lòng thử lại.";
      Alert.alert("Lỗi", errorMessage);
    } finally {
      setIsSending(false);
    }
  }, [
    conversationId,
    currentUserId,
    emitSocketMessage,
    fetchMessages,
    input,
    isSending,
    scrollToEnd,
    selectedAttachment,
    socketConnected,
    isConversationActive,
    statusMeta.description,
  ]);

  const handleOpenAttachment = useCallback((uri: string) => {
    if (!uri) {
      return;
    }
    Linking.openURL(uri).catch((err) => {
      console.error("Failed to open attachment", err);
      Alert.alert("Không thể mở tệp", "Vui lòng thử lại sau.");
    });
  }, []);

  const handleDeleteMessage = useCallback(
    (message: ChatMessage) => {
      if (!message.id || message.status === "sending") {
        return;
      }

      Alert.alert("Xóa tin nhắn", "Tin nhắn sẽ bị xóa khỏi thiết bị của bạn.", [
        { text: "Hủy", style: "cancel" },
        {
          text: "Xóa",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteChatMessage(message.id);
              setMessages((prev) => prev.filter((item) => item.id !== message.id));
            } catch (err: any) {
              console.error("Delete message failed", err);
              const messageText =
                err?.response?.data?.message ?? "Không thể xóa tin nhắn. Vui lòng thử lại.";
              Alert.alert("Lỗi", messageText);
            }
          },
        },
      ]);
    },
    [],
  );

  const handleMessageOptions = useCallback(
    (message: ChatMessage, event: GestureResponderEvent) => {
      if (!message.id || message.status === "sending") {
        return;
      }
      const { pageX, pageY } = event.nativeEvent;
      setMessageMenuState({ message, x: pageX, y: pageY });
    },
    [],
  );

  const canSend = useMemo(() => {
    if (!isConversationActive) {
      return false;
    }
    return (input.trim().length > 0 || Boolean(selectedAttachment)) && !isSending;
  }, [input, isConversationActive, isSending, selectedAttachment]);

  // Khi phiên không còn ACTIVE, đóng menu và bỏ file đính kèm đang chọn
  useEffect(() => {
    if (isInteractionLocked) {
      setAttachmentMenuVisible(false);
      if (selectedAttachment) {
        setSelectedAttachment(null);
      }
    }
  }, [isInteractionLocked, selectedAttachment]);

  const hasPendingReadReceipts = useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === "outgoing" &&
          !message.isRecalled &&
          message.status !== "read",
      ),
    [messages],
  );

  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => {
      const isOutgoing = item.role === "outgoing";
      const attachments = !item.isRecalled ? item.attachments ?? [] : [];

      const bubble =
        item.isRecalled ? (
          <View style={[styles.bubble, styles.recalledBubble]}>
            <Text style={styles.recalledText}>Tin nhắn đã được thu hồi</Text>
          </View>
        ) : item.content ? (
          <View style={[styles.bubble, isOutgoing ? styles.bubbleOutgoing : styles.bubbleIncoming]}>
            <Markdown
              style={{
                body: {
                  color: isOutgoing ? "#ffffff" : "#0f172a",
                  fontSize: 15,
                  lineHeight: 22,
                },
                link: {
                  color: isOutgoing ? "#bfdbfe" : "#3b82f6",
                },
                code_inline: {
                  backgroundColor: isOutgoing ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.05)",
                  color: isOutgoing ? "#ffffff" : "#0f172a",
                  paddingHorizontal: 4,
                  paddingVertical: 2,
                  borderRadius: 4,
                  fontSize: 14,
                },
                fence: {
                  backgroundColor: isOutgoing ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.05)",
                  color: isOutgoing ? "#ffffff" : "#0f172a",
                  padding: 8,
                  borderRadius: 6,
                },
              }}
            >
              {item.content}
            </Markdown>
          </View>
        ) : null;

      return (
        <TouchableOpacity
          activeOpacity={0.9}
          onLongPress={(event) => handleMessageOptions(item, event)}
          delayLongPress={250}
        >
          <View
            style={[
              styles.messageRow,
              isOutgoing ? styles.alignRight : styles.alignLeft,
            ]}
          >
            {attachments.length ? (
              <View style={[styles.attachmentGroup, isOutgoing && styles.attachmentOutgoing]}>
                {attachments.map((attachment) =>
                  attachment.kind === "image" ? (
                    <Image key={attachment.id} source={{ uri: attachment.uri }} style={styles.messageImage} />
                  ) : (
                    <TouchableOpacity
                      key={attachment.id}
                      style={styles.videoAttachment}
                      onPress={() => handleOpenAttachment(attachment.uri)}
                    >
                      <Ionicons name="videocam" size={18} color={Colors.primary} />
                      <Text style={styles.videoText}>Xem video</Text>
                    </TouchableOpacity>
                  ),
                )}
              </View>
            ) : null}
            {bubble}
            {isOutgoing ? (
              <Text style={styles.statusLabel}>
                {item.isRecalled
                  ? "Đã thu hồi"
                  : item.status === "failed"
                    ? "Lỗi"
                    : item.status === "sending"
                      ? "Đang gửi..."
                      : item.status === "delivered"
                        ? "Đã giao"
                        : item.status === "read"
                          ? "Đã xem"
                          : "Đã gửi"}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
      );
    },
    [handleMessageOptions, handleOpenAttachment],
  );

  const insets = useSafeAreaInsets();
  const screenWidth = Dimensions.get("window").width;
  const screenHeight = Dimensions.get("window").height;

  const headerInfo = useMemo(
    () => (
      <View style={styles.infoHeaderWrapper}>
        <View style={styles.infoHeader}>
          <View style={styles.avatarWrapper}>
            {partnerAvatar ? (
              <Image source={{ uri: partnerAvatar }} style={styles.avatarImage} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Ionicons name="person-outline" size={20} color="#64748b" />
              </View>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.infoTitle}>{conversationTitle}</Text>
            <Text style={styles.infoSubtitle}>
              {isPartnerOnline ? "Đang hoạt động" : "Ngoại tuyến"}
            </Text>
            <View style={styles.statusRow}>
              {socketConnected ? (
                <View style={[styles.connectionBadge, styles.connectionBadgeOnline]}>
                  <View style={[styles.connectionDot, styles.connectionDotOnline]} />
                  <Text style={styles.connectionBadgeText}>Đã kết nối realtime</Text>
                </View>
              ) : null}
              <View
                style={[
                  styles.conversationStatusBadge,
                  normalizedConversationStatus === "ACTIVE"
                    ? styles.statusPillActive
                    : normalizedConversationStatus === "WAITING"
                      ? styles.statusPillWaiting
                      : normalizedConversationStatus === "CANCELLED"
                        ? styles.statusPillCancelled
                        : normalizedConversationStatus === "ENDED"
                          ? styles.statusPillEnded
                          : styles.statusPillDefault,
                ]}
              >
                <Text style={styles.conversationStatusBadgeText}>{statusMeta.label}</Text>
              </View>
            </View>
            <Text style={styles.statusDescription}>{statusMeta.description}</Text>
          </View>
        </View>
        {legacyStatusWarning ? (
          <View style={styles.legacyWarningBanner}>
            <Ionicons name="warning-outline" size={18} color="#b45309" />
            <View style={styles.legacyWarningTextBlock}>
              <Text style={styles.legacyWarningTitle}>Không thể tải toàn bộ lịch sử</Text>
              <Text style={styles.legacyWarningText}>{legacyStatusWarning}</Text>
            </View>
          </View>
        ) : null}
        {sessionNotice ? (
          <View
            style={[
              styles.sessionNoticeBanner,
              sessionNotice.type === "warning"
                ? styles.sessionNoticeWarning
                : sessionNotice.type === "error"
                  ? styles.sessionNoticeError
                  : styles.sessionNoticeInfo,
            ]}
          >
            <Ionicons
              name={sessionNotice.type === "warning" ? "time-outline" : sessionNotice.type === "error" ? "close-circle" : "information-circle"}
              size={18}
              color={
                sessionNotice.type === "warning"
                  ? "#b45309"
                  : sessionNotice.type === "error"
                    ? "#b91c1c"
                    : "#0f172a"
              }
            />
            <Text style={styles.sessionNoticeText}>{sessionNotice.message}</Text>
            <TouchableOpacity onPress={() => setSessionNotice(null)}>
              <Ionicons name="close" size={16} color="#475569" />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    ),
    [
      conversationTitle,
      isPartnerOnline,
      legacyStatusWarning,
      normalizedConversationStatus,
      partnerAvatar,
      sessionNotice,
      socketConnected,
      statusMeta.description,
      statusMeta.label,
    ],
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 24 : 0}
      >
        {/* Modal xác nhận hủy phiên (thay Alert để hợp giao diện chat) */}
        <Modal
          visible={cancelModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setCancelModalVisible(false)}
        >
          <TouchableWithoutFeedback onPress={() => setCancelModalVisible(false)}>
            <View style={styles.modalBackdrop}>
              <TouchableWithoutFeedback>
                <View style={styles.cancelModalCard}>
                  <View style={styles.modalHeader}>
                    <Ionicons name="alert-circle" size={24} color="#b91c1c" />
                    <Text style={styles.modalTitle}>Hủy phiên trò chuyện</Text>
                  </View>
                  <Text style={styles.modalBodyText}>
                    Bạn muốn hủy phiên này? Người còn lại sẽ nhận được yêu cầu xác nhận.
                  </Text>
                  <View style={styles.modalActions}>
                    <TouchableOpacity
                      style={[styles.modalButton, styles.modalGhostButton]}
                      onPress={() => setCancelModalVisible(false)}
                      disabled={cancelRequestPending}
                    >
                      <Text style={[styles.modalButtonText, styles.modalGhostText]}>Giữ phiên</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.modalButton, styles.modalDangerButton, cancelRequestPending && styles.modalButtonDisabled]}
                      onPress={confirmCancelSession}
                      disabled={cancelRequestPending}
                    >
                      {cancelRequestPending ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={[styles.modalButtonText, styles.modalDangerText]}>Gửi yêu cầu hủy</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>

        {/* Modal phản hồi yêu cầu hủy từ đối phương */}
        <Modal
          visible={incomingCancelModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setIncomingCancelModalVisible(false)}
        >
          <TouchableWithoutFeedback onPress={() => setIncomingCancelModalVisible(false)}>
            <View style={styles.modalBackdrop}>
              <TouchableWithoutFeedback>
                <View style={styles.cancelModalCard}>
                  <View style={styles.modalHeader}>
                    <Ionicons name="close-circle" size={24} color="#ef4444" />
                    <Text style={styles.modalTitle}>Đối phương muốn hủy phiên</Text>
                  </View>
                  <Text style={styles.modalBodyText}>
                    {cancelRequesterName} vừa yêu cầu hủy phiên này. Bạn có đồng ý không?
                  </Text>
                  <View style={styles.modalActions}>
                    <TouchableOpacity
                      style={[styles.modalButton, styles.modalGhostButton]}
                      onPress={handleDeclineIncomingCancel}
                    >
                      <Text style={[styles.modalButtonText, styles.modalGhostText]}>Tiếp tục phiên</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.modalButton, styles.modalDangerButton]}
                      onPress={handleAcceptIncomingCancel}
                    >
                      <Text style={[styles.modalButtonText, styles.modalDangerText]}>Đồng ý hủy</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>

        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
            <Ionicons name="arrow-back" size={24} color={Colors.black} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Trò chuyện</Text>
          <View style={styles.headerActions}>
            {canCancelSession ? (
              <TouchableOpacity
                onPress={handleRequestCancelSession}
                style={[styles.headerCancelButton, cancelButtonDisabled && styles.headerCancelButtonDisabled]}
                disabled={cancelButtonDisabled}
              >
                <Ionicons name="close-circle" size={18} color="#b91c1c" />
                <Text style={styles.headerCancelText}>
                  {cancelRequestPending ? "Đang chờ..." : "Hủy phiên"}
                </Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              onPress={handleVideoCallPress}
              disabled={isCallDisabled}
              style={[styles.headerIconButton, isCallDisabled && styles.headerIconButtonDisabled]}
            >
              <Ionicons
                name="videocam"
                size={22}
                color={isCallDisabled ? Colors.gray : Colors.primary}
              />
            </TouchableOpacity>
          </View>
        </View>

        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={headerInfo}
          ListFooterComponent={
            isSending ? (
              <View style={styles.sendingIndicator}>
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={styles.sendingText}>Đang gửi tin nhắn...</Text>
              </View>
            ) : (
              <View style={{ height: 12 }} />
            )
          }
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => fetchMessages({ refreshing: true })}
              tintColor={Colors.primary}
              colors={[Colors.primary]}
            />
          }
          ListEmptyComponent={
            isLoading ? (
              <View style={styles.emptyState}>
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={styles.emptyText}>Đang tải cuộc trò chuyện...</Text>
              </View>
            ) : loadError ? (
              <TouchableOpacity style={styles.errorState} onPress={() => fetchMessages()}>
                <Ionicons name="warning-outline" size={20} color="#b91c1c" />
                <Text style={styles.errorStateText}>{loadError}</Text>
                <Text style={styles.errorRetryHint}>Nhấn để thử lại</Text>
              </TouchableOpacity>
            ) : legacyStatusWarning ? (
              <View style={styles.legacyEmptyState}>
                <Ionicons name="alert-circle-outline" size={22} color="#b45309" />
                <Text style={styles.legacyEmptyTitle}>Không thể tải lịch sử cũ</Text>
                <Text style={styles.legacyEmptyText}>{legacyStatusWarning}</Text>
              </View>
            ) : normalizedConversationStatus !== "ACTIVE" ? (
              <View style={styles.statusEmptyState}>
                <Ionicons
                  name={normalizedConversationStatus === "WAITING" ? "time-outline" : "ban-outline"}
                  size={22}
                  color="#475569"
                />
                <Text style={styles.statusEmptyTitle}>{statusMeta.label}</Text>
                <Text style={styles.statusEmptyText}>{statusMeta.description}</Text>
              </View>
            ) : (
              <View style={styles.emptyState}>
                <Ionicons name="chatbubble-ellipses-outline" size={24} color={Colors.gray} />
                <Text style={styles.emptyText}>Hãy gửi tin nhắn đầu tiên để bắt đầu trao đổi.</Text>
              </View>
            )
          }
          showsVerticalScrollIndicator={false}
        />

        <View style={[styles.inputArea, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {selectedAttachment ? (
            <View style={styles.previewRow}>
              <View style={styles.previewItem}>
                {selectedAttachment.kind === "image" ? (
                  <Image source={{ uri: selectedAttachment.uri }} style={styles.previewImage} />
                ) : (
                  <View style={styles.previewVideo}>
                    <Ionicons name="videocam" size={18} color={Colors.white} />
                    <Text style={styles.previewVideoText}>Video đính kèm</Text>
                  </View>
                )}
                <TouchableOpacity style={styles.removePreviewButton} onPress={handleRemoveAttachment}>
                  <Ionicons name="close" size={16} color={Colors.white} />
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          <View style={styles.inputRow}>
            <TouchableOpacity
              style={[styles.iconButton, isInteractionLocked && styles.headerIconButtonDisabled]}
              onPress={handleAttachmentMenu}
              disabled={isInteractionLocked}
            >
              <Ionicons
                name="attach-outline"
                size={20}
                color={isInteractionLocked ? Colors.gray : "#475569"}
              />
            </TouchableOpacity>
            <TextInput
              style={styles.messageInput}
              placeholder={inputPlaceholder}
              placeholderTextColor="#94a3b8"
              value={input}
              onChangeText={setInput}
              multiline
              editable={isConversationActive}
              selectTextOnFocus={isConversationActive}
              onSubmitEditing={() => {
                if (Platform.OS === "ios" && isConversationActive) {
                  handleSendMessage();
                }
              }}
              returnKeyType="send"
            />
            <TouchableOpacity
              style={[styles.sendButton, (!canSend || isSending) && styles.sendButtonDisabled]}
              onPress={handleSendMessage}
              disabled={!canSend}
            >
              {isSending ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Ionicons name="paper-plane" size={18} color={Colors.white} />
              )}
            </TouchableOpacity>
          </View>
        </View>

        {isAttachmentMenuVisible ? (
          <View style={styles.popoverOverlay} pointerEvents="box-none">
            <TouchableWithoutFeedback onPress={() => setAttachmentMenuVisible(false)}>
              <View style={styles.popoverBackdrop} />
            </TouchableWithoutFeedback>
            <View
              style={[
                styles.attachmentPopover,
                { bottom: Math.max(insets.bottom, 12) + 86 },
              ]}
            >
              <View style={styles.popoverArrowDown} />
              <TouchableOpacity style={styles.popoverOption} onPress={handleSelectImageFromMenu}>
                <Text style={styles.popoverOptionText}>Ảnh</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.popoverOption} onPress={handleSelectVideoFromMenu}>
                <Text style={styles.popoverOptionText}>Video</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.popoverOption, styles.popoverOptionLast]}
                onPress={() => setAttachmentMenuVisible(false)}
              >
                <Text style={styles.popoverOptionText}>Hủy</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {messageMenuState ? (
          <View style={styles.popoverOverlay} pointerEvents="box-none">
            <TouchableWithoutFeedback onPress={closeMessageMenu}>
              <View style={styles.popoverBackdrop} />
            </TouchableWithoutFeedback>
            {(() => {
              const align =
                messageMenuState.message.role === "outgoing" ? "right" : "left";
              const MENU_WIDTH = 196;
              const horizontalOffset = 18;
              const computedLeft =
                align === "right"
                  ? Math.max(messageMenuState.x - MENU_WIDTH - horizontalOffset, 12)
                  : Math.min(messageMenuState.x + horizontalOffset, screenWidth - MENU_WIDTH - 12);
              const computedTop = Math.min(
                Math.max(messageMenuState.y - 60, 80),
                screenHeight - 200,
              );
              return (
                <View style={[styles.messageMenuCard, { top: computedTop, left: computedLeft, width: MENU_WIDTH }]}>
                  <View
                    style={[
                      styles.messageMenuArrow,
                      align === "right" ? styles.messageMenuArrowRight : styles.messageMenuArrowLeft,
                    ]}
                  />
                  {!messageMenuState.message.isRecalled ? (
                    <>
                      <TouchableOpacity
                        style={styles.messageMenuOption}
                        onPress={() => {
                          handleDeleteMessage(messageMenuState.message);
                          closeMessageMenu();
                        }}
                      >
                        <View style={[styles.messageMenuIcon, styles.messageMenuIconDanger]}>
                          <Ionicons name="trash-outline" size={18} color="#ef4444" />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.messageMenuLabel}>Xóa phía tôi</Text>
                          <Text style={styles.messageMenuHint}>Tin nhắn sẽ biến mất khỏi thiết bị</Text>
                        </View>
                      </TouchableOpacity>
                      <View style={styles.messageMenuDivider} />
                    </>
                  ) : null}
                  <TouchableOpacity
                    style={styles.messageMenuOption}
                    onPress={closeMessageMenu}
                  >
                    <View style={styles.messageMenuIcon}>
                      <Ionicons name="close" size={18} color="#0f172a" />
                    </View>
                    <Text style={styles.messageMenuLabel}>Đóng</Text>
                  </TouchableOpacity>
                </View>
              );
            })()}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.grayBackground,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e2e8f0",
  },
  headerButton: {
    padding: 6,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: Colors.black,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerIconButton: {
    padding: 6,
    borderRadius: 18,
    backgroundColor: "#f1f5f9",
  },
  headerIconButtonDisabled: {
    opacity: 0.5,
  },
  headerCancelButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "#fee2e2",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#fecdd3",
  },
  headerCancelButtonDisabled: {
    opacity: 0.65,
  },
  headerCancelText: {
    color: "#b91c1c",
    fontWeight: "700",
    fontSize: 13,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 140,
    gap: 12,
  },
  infoHeaderWrapper: {
    gap: 8,
    marginBottom: 12,
  },
  infoHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 0,
  },
  avatarWrapper: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#e2e8f0",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.black,
  },
  infoSubtitle: {
    marginTop: 2,
    fontSize: 13,
    color: Colors.gray,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
    flexWrap: "wrap",
  },
  connectionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  connectionBadgeOnline: {
    backgroundColor: "#dcfce7",
  },
  connectionBadgeOffline: {
    backgroundColor: "#fee2e2",
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connectionDotOnline: {
    backgroundColor: "#22c55e",
  },
  connectionDotOffline: {
    backgroundColor: "#f87171",
  },
  connectionBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#0f172a",
  },
  conversationStatusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  conversationStatusBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#0f172a",
  },
  statusPillActive: {
    backgroundColor: "#dcfce7",
  },
  statusPillWaiting: {
    backgroundColor: "#fef9c3",
  },
  statusPillCancelled: {
    backgroundColor: "#fee2e2",
  },
  statusPillEnded: {
    backgroundColor: "#e2e8f0",
  },
  statusPillDefault: {
    backgroundColor: "#e2e8f0",
  },
  statusDescription: {
    marginTop: 4,
    fontSize: 12,
    color: "#475569",
  },
  legacyWarningBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#fffbeb",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#fed7aa",
  },
  legacyWarningTextBlock: {
    flex: 1,
    gap: 4,
  },
  legacyWarningTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#b45309",
  },
  legacyWarningText: {
    fontSize: 12,
    color: "#92400e",
    lineHeight: 18,
  },
  socketWarningBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#fef2f2",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#fecaca",
  },
  socketWarningTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#b91c1c",
  },
  socketWarningText: {
    fontSize: 12,
    color: "#b91c1c",
    lineHeight: 18,
  },
  messageRow: {
    gap: 6,
    marginBottom: 10,
    paddingHorizontal: 6,
  },
  alignLeft: {
    alignSelf: "flex-start",
    alignItems: "flex-start",
  },
  alignRight: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
  },
  attachmentGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 4,
  },
  attachmentOutgoing: {
    justifyContent: "flex-end",
  },
  messageImage: {
    width: 160,
    height: 160,
    borderRadius: 14,
  },
  videoAttachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: "#e0f2fe",
  },
  videoText: {
    fontSize: 13,
    color: "#0369a1",
  },
  bubble: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
    maxWidth: "82%",
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 1,
  },
  bubbleIncoming: {
    backgroundColor: "#f8fafc",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e2e8f0",
  },
  bubbleOutgoing: {
    backgroundColor: Colors.primary,
  },
  recalledBubble: {
    backgroundColor: "#e2e8f0",
  },
  messageText: {
    fontSize: 14,
    color: Colors.black,
    lineHeight: 20,
  },
  messageTextOutgoing: {
    color: Colors.white,
  },
  statusLabel: {
    fontSize: 11,
    color: Colors.gray,
    marginTop: 2,
  },
  recalledText: {
    fontSize: 13,
    fontStyle: "italic",
    color: "#475569",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
    gap: 10,
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    color: Colors.gray,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  legacyEmptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 36,
    paddingHorizontal: 16,
    gap: 8,
  },
  legacyEmptyTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#b45309",
    textAlign: "center",
  },
  legacyEmptyText: {
    fontSize: 13,
    lineHeight: 19,
    color: "#92400e",
    textAlign: "center",
  },
  sessionNoticeBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    marginTop: 6,
  },
  sessionNoticeInfo: {
    backgroundColor: "#eef2ff",
  },
  sessionNoticeWarning: {
    backgroundColor: "#fef3c7",
  },
  sessionNoticeError: {
    backgroundColor: "#fee2e2",
  },
  sessionNoticeText: {
    flex: 1,
    fontSize: 13,
    color: "#0f172a",
  },
  statusEmptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 36,
    paddingHorizontal: 16,
    gap: 8,
  },
  statusEmptyTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#0f172a",
    textAlign: "center",
  },
  statusEmptyText: {
    fontSize: 13,
    lineHeight: 19,
    color: "#475569",
    textAlign: "center",
    paddingHorizontal: 16,
  },
  errorState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
    gap: 8,
  },
  errorStateText: {
    fontSize: 14,
    color: "#b91c1c",
    textAlign: "center",
    paddingHorizontal: 32,
  },
  errorRetryHint: {
    fontSize: 12,
    color: Colors.gray,
  },
  sendingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "center",
    paddingVertical: 12,
  },
  sendingText: {
    fontSize: 12,
    color: Colors.gray,
  },
  previewRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  previewItem: {
    position: "relative",
  },
  previewImage: {
    width: 70,
    height: 70,
    borderRadius: 12,
  },
  previewVideo: {
    width: 70,
    height: 70,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    gap: 4,
  },
  previewVideoText: {
    fontSize: 11,
    color: Colors.white,
    textAlign: "center",
  },
  removePreviewButton: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
  inputArea: {
    paddingHorizontal: 16,
    backgroundColor: Colors.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e2e8f0",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 28,
    backgroundColor: "#f1f5f9",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e2e8f0",
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e2e8f0",
  },
  messageInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    color: Colors.black,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primary,
    shadowColor: Colors.primary,
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  sendButtonDisabled: {
    backgroundColor: "#cbd5f5",
    shadowOpacity: 0,
    elevation: 0,
  },
  popoverOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  popoverBackdrop: {
    flex: 1,
    backgroundColor: "transparent",
  },
  attachmentPopover: {
    position: "absolute",
    left: 36,
    width: 140,
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    zIndex: 20,
  },
  popoverOption: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  popoverOptionLast: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e2e8f0",
  },
  popoverOptionText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#0f172a",
  },
  popoverArrowDown: {
    position: "absolute",
    bottom: -6,
    left: 20,
    width: 12,
    height: 12,
    backgroundColor: Colors.white,
    transform: [{ rotate: "45deg" }],
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "#e2e8f0",
    zIndex: 21,
  },
  messageMenuCard: {
    position: "absolute",
    backgroundColor: Colors.white,
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 12,
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
    zIndex: 25,
  },
  messageMenuOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  messageMenuIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(15,23,42,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  messageMenuIconDanger: {
    backgroundColor: "rgba(239,68,68,0.12)",
  },
  messageMenuLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: "#0f172a",
  },
  messageMenuHint: {
    fontSize: 12,
    color: "#64748b",
    marginTop: 2,
  },
  messageMenuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#e2e8f0",
    marginVertical: 4,
  },
  messageMenuArrow: {
    position: "absolute",
    width: 12,
    height: 12,
    backgroundColor: Colors.white,
    transform: [{ rotate: "45deg" }],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e2e8f0",
    zIndex: -1,
  },
  messageMenuArrowLeft: {
    left: -6,
    top: 24,
  },
  messageMenuArrowRight: {
    right: -6,
    top: 24,
  },

  // Cancel modal styles
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  cancelModalCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#0f172a",
  },
  modalBodyText: {
    fontSize: 15,
    color: "#334155",
    lineHeight: 22,
    marginBottom: 18,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  modalButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    minWidth: 120,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
  },
  modalButtonDisabled: {
    opacity: 0.7,
  },
  modalGhostButton: {
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  modalGhostText: {
    color: "#0f172a",
    fontWeight: "600",
  },
  modalDangerButton: {
    backgroundColor: "#ef4444",
  },
  modalDangerText: {
    color: "#fff",
    fontWeight: "700",
  },
  modalButtonText: {
    fontSize: 15,
  },
})
