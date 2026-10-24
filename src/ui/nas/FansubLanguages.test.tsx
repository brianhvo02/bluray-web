// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FansubLanguages } from './FansubLanguages';

afterEach(cleanup);

it('shows English fixed and saves a ticked language', async () => {
  const setFansubLanguages = vi.fn(async (c: readonly string[]) => ['eng', ...c.filter((x) => x !== 'eng')]);
  render(<FansubLanguages nas={{ fansubLanguages: async () => ['eng'], setFansubLanguages }} />);
  const spa = (await screen.findByTestId('fansub-language-spa')) as HTMLInputElement;
  expect(spa.checked).toBe(false);
  fireEvent.click(spa);
  await waitFor(() => expect(setFansubLanguages).toHaveBeenCalledWith(['eng', 'spa']));
  await waitFor(() => expect((screen.getByTestId('fansub-language-spa') as HTMLInputElement).checked).toBe(true));
});
