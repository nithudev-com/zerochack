import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

const cx = (...values: Array<string | false | null | undefined>): string => values.filter(Boolean).join(' ');

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger'; size?: 'sm' | 'md' }>(({ className, variant = 'primary', size = 'md', ...props }, ref) => (
  <button ref={ref} className={cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, className)} {...props} />
));
Button.displayName = 'Button';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined }>(({ className, label, error, id, ...props }, ref) => {
  const inputId = id ?? props.name;
  return <label className="ui-field" htmlFor={inputId}><span className="ui-label">{label}</span><input ref={ref} id={inputId} className={cx('ui-input', error && 'ui-input--error', className)} aria-invalid={Boolean(error)} aria-describedby={error ? `${inputId}-error` : undefined} {...props} />{error && <span id={`${inputId}-error`} className="ui-field-error" role="alert">{error}</span>}</label>;
});
Input.displayName = 'Input';

export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => <div className={cx('ui-card', className)} {...props} />;
export const Alert = ({ title, children, tone = 'info' }: { title: string; children?: ReactNode; tone?: 'info' | 'success' | 'warning' | 'danger' }) => <div className={cx('ui-alert', `ui-alert--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}><strong>{title}</strong>{children && <div>{children}</div>}</div>;
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { label: string }>(({ label, className, id, children, ...props }, ref) => <label className="ui-field" htmlFor={id}><span className="ui-label">{label}</span><select ref={ref} id={id} className={cx('ui-input', className)} {...props}>{children}</select></label>);
Select.displayName = 'Select';

export const LoadingState = ({ label = 'Loading' }: { label?: string }) => <div className="ui-state" role="status"><span className="ui-spinner" aria-hidden="true" />{label}</div>;
export const EmptyState = ({ title, description, action }: { title: string; description: string; action?: ReactNode }) => <div className="ui-state"><strong>{title}</strong><p>{description}</p>{action}</div>;
export const ErrorState = ({ title = 'Something went wrong', description, retry }: { title?: string; description: string; retry?: () => void }) => <div className="ui-state" role="alert"><strong>{title}</strong><p>{description}</p>{retry && <Button variant="secondary" onClick={retry}>Try again</Button>}</div>;
