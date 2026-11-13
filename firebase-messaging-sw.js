/* H군 체크리스트 – 푸시 수신용 서비스워커
   index.html과 같은 폴더에 두세요. 앱이 닫혀 있을 때 도착한 푸시를 아이폰 알림으로 띄웁니다. */
importScripts('https://www.gstatic.com/firebasejs/12.4.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.4.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDdDxvqtHium8R8NnaD5V07iZhBjUyhZmg",
  authDomain: "junmo-29054.firebaseapp.com",
  projectId: "junmo-29054",
  storageBucket: "junmo-29054.firebasestorage.app",
  messagingSenderId: "271729254438",
  appId: "1:271729254438:web:cd6d48c1b3b0f743cf46e7"
});

// notification 형식의 푸시는 Firebase SDK가 자동으로 알림을 띄워 줍니다.
firebase.messaging();

// 앱이 열려 있을 때 index.html이 직접 띄운 알림을 누르면 앱으로 이동
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => list.length ? list[0].focus() : clients.openWindow('./'))
  );
});
