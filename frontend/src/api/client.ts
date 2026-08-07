import axios from 'axios';
import { emitMascotEvent, mutationDescription } from '../components/mascot/mascot-events';
import type { MascotOperation, MascotSubject } from '../components/mascot/mascot-events';

type MascotRequestConfig = {
  __mascotMutation?: { operation: MascotOperation; subject: MascotSubject };
};

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
});

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const method = config.method?.toUpperCase() ?? 'GET';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const mutation = mutationDescription(method, config.url ?? '');
    (config as typeof config & MascotRequestConfig).__mascotMutation = mutation;
    emitMascotEvent({ state: 'working', ...mutation });
  }
  return config;
});

client.interceptors.response.use(
  (response) => {
    const mutation = (response.config as typeof response.config & MascotRequestConfig).__mascotMutation;
    if (mutation) emitMascotEvent({ state: 'success', ...mutation });
    return response;
  },
  (err) => {
    const mutation = (err.config as (MascotRequestConfig & { url?: string; method?: string }) | undefined)?.__mascotMutation;
    if (mutation) emitMascotEvent({ state: 'error', ...mutation });
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('account');
      window.location.href = `${import.meta.env.BASE_URL}login`;
    }
    return Promise.reject(err);
  },
);

export default client;
