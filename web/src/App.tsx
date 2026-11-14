import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { RequireSession } from './components/Shell';
import { SignIn } from './features/session/SignIn';
import { createQueryClient } from './queryClient';

const Overview = lazy(() => import('./features/home/Overview').then((m) => ({ default: m.Overview })));
const Account = lazy(() => import('./features/account/Account').then((m) => ({ default: m.Account })));
const ImportList = lazy(() => import('./features/imports/ImportList').then((m) => ({ default: m.ImportList })));
const ImportNew = lazy(() => import('./features/imports/ImportNew').then((m) => ({ default: m.ImportNew })));
const ImportDetail = lazy(() => import('./features/imports/ImportDetail').then((m) => ({ default: m.ImportDetail })));
const ReviewList = lazy(() => import('./features/reviews/ReviewList').then((m) => ({ default: m.ReviewList })));
const ReviewDetail = lazy(() => import('./features/reviews/ReviewDetail').then((m) => ({ default: m.ReviewDetail })));
const Exports = lazy(() => import('./features/exports/Exports').then((m) => ({ default: m.Exports })));

const queryClient = createQueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<p className="main">Loading.</p>}>
          <Routes>
            <Route path="/sign-in" element={<SignIn />} />
            <Route element={<RequireSession />}>
              <Route path="/" element={<Overview />} />
              <Route path="/account" element={<Account />} />
              <Route path="/imports" element={<ImportList />} />
              <Route path="/imports/new" element={<ImportNew />} />
              <Route path="/imports/:id" element={<ImportDetail />} />
              <Route path="/reviews" element={<ReviewList />} />
              <Route path="/reviews/:id" element={<ReviewDetail />} />
              <Route path="/exports" element={<Exports />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
