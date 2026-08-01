import Dashboard from './dashboard';

export default function Page() {
  return <main>
    <p className="eyebrow">RHINOQ FAILURE LAB</p>
    <h1>The queue is green.<br/><span>The refund is not.</span></h1>
    <p className="lead">Reproduce a Stripe response-loss failure, inspect the evidence, then recover it without a blind retry or arbitrary SQL.</p>
    <Dashboard />
  </main>;
}
