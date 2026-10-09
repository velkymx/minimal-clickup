import { createRouter, createWebHistory } from 'vue-router'
import ChatWindow from './components/ChatWindow.vue'
import DashboardView from './components/DashboardView.vue'
import TaskDetail from './components/TaskDetail.vue'
import TasksView from './components/TasksView.vue'

// Bookmarkable channel URLs. Client-side routing only — no server needed;
// Vite (and any static host with SPA fallback) serves index.html for these.
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ChatWindow },
    { path: '/channel/:channelId', component: ChatWindow },
    { path: '/dashboard', component: DashboardView },
    { path: '/tasks', component: TasksView },
    { path: '/tasks/:taskId', component: TaskDetail },
  ],
})
