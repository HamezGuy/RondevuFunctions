import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();

interface NotificationData {
  recipientId?: string;
  title?: string;
  message?: string;
  type?: string;
  status?: string;
  createdAt?: admin.firestore.Timestamp;
  metadata?: Record<string, any>;
  actionLink?: string;
  imageUrl?: string;
}

interface EventData {
  creatorId?: string;
  name?: string;
  startTime?: admin.firestore.Timestamp;
  venueAddress?: string;
  reminderSent?: boolean;
  attendees?: string[];
}

// Send push notification when a new notification is created
export const sendNotificationToUser = functions.firestore
  .document("{collection}/{notificationId}")
  .onCreate(async (snapshot, context) => {
    try {
      const collection = context.params.collection as string;
      
      // Only trigger for notification collections
      if (collection !== "user_notifications" && collection !== "creator_notifications") {
        return null;
      }
      
      const notification = snapshot.data() as NotificationData;
      const recipientId = notification.recipientId;
      
      if (!recipientId) {
        console.log("No recipient ID found in notification");
        return null;
      }
      
      // Get the user's FCM token
      const userTokensDoc = await admin.firestore()
        .collection("user_tokens")
        .doc(recipientId)
        .get();
      
      if (!userTokensDoc.exists) {
        console.log(`No token found for user: ${recipientId}`);
        return null;
      }
      
      const userData = userTokensDoc.data();
      const token = userData?.token;
      
      if (!token) {
        console.log(`Token exists but is empty for user: ${recipientId}`);
        return null;
      }
      
      // Create notification message
      const messageData: Record<string, string> = {
        notificationId: context.params.notificationId,
        type: notification.type || "",
        click_action: "FLUTTER_NOTIFICATION_CLICK",
        actionLink: notification.actionLink || "",
      };
      
      // Add any metadata that might be useful
      if (notification.metadata) {
        // Don't include large objects in the data payload
        const metadataToInclude = { ...notification.metadata };
        
        // Remove any large objects that might exceed FCM payload limits
        delete metadataToInclude.fullDescription;
        delete metadataToInclude.fullContent;
        
        Object.keys(metadataToInclude).forEach(key => {
          messageData[key] = typeof metadataToInclude[key] === "object" 
            ? JSON.stringify(metadataToInclude[key]) 
            : String(metadataToInclude[key]);
        });
      }
      
      const message: admin.messaging.Message = {
        notification: {
          title: notification.title,
          body: notification.message,
          imageUrl: notification.imageUrl,
        },
        data: messageData,
        token: token,
        android: {
          priority: "high",
          notification: {
            sound: "default",
            priority: "high",
            channelId: "high_importance_channel",
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
              badge: 1,
            },
          },
        },
      };
      
      // Send message
      const response = await admin.messaging().send(message);
      console.log("Successfully sent message:", response);
      return response;
    } catch (error) {
      console.error("Error sending notification:", error);
      return null;
    }
  });

// Optional: Update badge count when notification status changes
export const updateBadgeCount = functions.firestore
  .document("{collection}/{notificationId}")
  .onUpdate(async (change, context) => {
    try {
      const collection = context.params.collection as string;
      
      // Only trigger for notification collections
      if (collection !== "user_notifications" && collection !== "creator_notifications") {
        return null;
      }
      
      const beforeData = change.before.data() as NotificationData;
      const afterData = change.after.data() as NotificationData;
      
      // Only proceed if status changed from unread to something else
      if (beforeData.status === "unread" && afterData.status !== "unread") {
        const recipientId = afterData.recipientId;
        
        if (!recipientId) {
          return null;
        }
        
        // Get unread count for this user
        const unreadQuery = await admin.firestore()
          .collection(collection)
          .where("recipientId", "==", recipientId)
          .where("status", "==", "unread")
          .get();
        
        const unreadCount = unreadQuery.docs.length;
        
        // Get user's FCM token
        const userTokensDoc = await admin.firestore()
          .collection("user_tokens")
          .doc(recipientId)
          .get();
        
        if (!userTokensDoc.exists) {
          return null;
        }
        
        const userData = userTokensDoc.data();
        const token = userData?.token;
        
        if (!token) {
          return null;
        }
        
        // Update badge count for iOS devices
        await admin.messaging().send({
          token: token,
          apns: {
            payload: {
              aps: {
                badge: unreadCount,
              },
            },
          },
          // Must include at least one field other than apns
          data: {
            updateBadge: "true",
          },
        });
        
        return { success: true };
      }
      
      return null;
    } catch (error) {
      console.error("Error updating badge count:", error);
      return null;
    }
  });

// Optional: Scheduled function to send event reminder notifications
export const sendEventReminders = functions.pubsub
  .schedule("every 1 hours")
  .onRun(async () => {  // Removed unused context parameter
    try {
      const now = admin.firestore.Timestamp.now();
      const oneHourLater = new admin.firestore.Timestamp(
        now.seconds + 3600, // 1 hour in seconds
        now.nanoseconds
      );
      const twoHoursLater = new admin.firestore.Timestamp(
        now.seconds + 7200, // 2 hours in seconds
        now.nanoseconds
      );
      
      // Find events starting in the next 1-2 hours
      const eventsSnapshot = await admin.firestore()
        .collection("events")
        .where("startTime", ">=", oneHourLater)
        .where("startTime", "<=", twoHoursLater)
        .get();
      
      if (eventsSnapshot.empty) {
        console.log("No upcoming events found for reminders");
        return null;
      }
      
      console.log(`Found ${eventsSnapshot.docs.length} events for reminders`);
      
      const batch = admin.firestore().batch();
      const promises: Promise<admin.firestore.DocumentReference>[] = [];
      
      // Process each event
      for (const eventDoc of eventsSnapshot.docs) {
        const event = eventDoc.data() as EventData;
        
        // Check if reminder already sent
        if (event.reminderSent) {
          continue;
        }
        
        // Mark reminder as sent
        batch.update(eventDoc.ref, { reminderSent: true });
        
        // Send reminder to event creator
        if (event.creatorId) {
          promises.push(
            admin.firestore().collection("creator_notifications").add({
              recipientId: event.creatorId,
              recipientType: "eventCreator",
              title: "Event Starting Soon",
              message: `Your "${event.name}" event starts in less than 2 hours.`,
              type: "eventStartingSoon",
              status: "unread",
              createdAt: now,
              metadata: {
                eventId: eventDoc.id,
                eventName: event.name,
                startTime: event.startTime?.toMillis(),
                venueAddress: event.venueAddress,
              },
              actionLink: `event/${eventDoc.id}`,
            })
          );
        }
        
        // Send reminders to registered attendees
        if (event.attendees && event.attendees.length > 0) {
          for (const attendeeId of event.attendees) {
            promises.push(
              admin.firestore().collection("user_notifications").add({
                recipientId: attendeeId,
                recipientType: "user",
                title: "Event Starting Soon",
                message: `"${event.name}" starts in less than 2 hours.`,
                type: "eventStartingSoon",
                status: "unread",
                createdAt: now,
                metadata: {
                  eventId: eventDoc.id,
                  eventName: event.name,
                  startTime: event.startTime?.toMillis(),
                  venueAddress: event.venueAddress,
                },
                actionLink: `event/${eventDoc.id}`,
              })
            );
          }
        }
      }
      
      // Commit the batch update
      await batch.commit();
      
      // Wait for all notification creations to complete
      await Promise.all(promises);
      
      console.log(`Sent ${promises.length} reminder notifications`);
      return { success: true };
    } catch (error) {
      console.error("Error sending event reminders:", error);
      return null;
    }
  });