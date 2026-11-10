import { copyText } from './clipboard';

const mockSetString = jest.fn();
jest.mock('react-native', () => ({
  Clipboard: {
    setString: (t: string) => mockSetString(t),
  },
}));

describe('copyText', () => {
  it('writes to the system clipboard', () => {
    expect(copyText('hello')).toBe(true);
    expect(mockSetString).toHaveBeenCalledWith('hello');
  });
  it('returns false when the platform call throws', () => {
    mockSetString.mockImplementationOnce(() => {
      throw new Error('no clipboard');
    });
    expect(copyText('x')).toBe(false);
  });
});
