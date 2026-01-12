import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'offaxis',
      component: () => import('../views/OffAxisView.vue'),
    },
  ],
})

export default router
